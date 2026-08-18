/**
 * dsh-session-delete — host plugin.
 *
 * Registers POST /api/session-delete { sessionId } consumed by the left
 * workspace sidebar's session row menu ("删除对话"). The endpoint performs
 * the full teardown the workspace registry cannot do alone:
 *
 *   1. refuses sessions whose agent is running or has pending inbox items;
 *   2. detaches the live agent + live session (retirement flush completes
 *      before files are touched, so a final write cannot resurrect the log);
 *   3. removes the session from every workspace account and the archive set
 *      (portable: public entity.detachSession + domain-global archive sync,
 *      with an optional fast path when a patched registry provides
 *      removeSession);
 *   4. deletes the durable session directory (jsonl log + session-local files).
 *
 * Everything is guarded: on an unknown/hostile layout the route degrades to
 * registry-only cleanup and reports what it did, instead of crashing.
 */
import { rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const name = "dsh-session-delete";

/** Write a JSON payload with no-store caching. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/** True when the request's Origin matches its Host — required on POST routes. */
function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Read and parse a JSON request body, rejecting anything over 4 KiB. */
async function readJsonBody(request, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * One filesystem-safe path segment (mirrors the jsonl persistence backend's
 * encodeSegment: `~` + 4-digit hex for every unsafe code unit, `.`/`..`
 * spelled explicitly so nothing can traverse).
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Readable project directory key (mirrors projectKey of the jsonl backend). */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * The session directory under the backend root. Prefers the backend's own
 * `locate()` (authoritative: compression suffix, encoding, root) and falls
 * back to the documented `<root>/<projectKey>/<encodeSegment(id)>` layout.
 * Returns undefined when neither the backend nor a header cwd is available.
 */
function sessionDirFor(persistence, header) {
  if (persistence !== undefined && header !== undefined) {
    if (typeof persistence.locate === "function") {
      try {
        const located = persistence.locate({ id: header.id, cwd: header.cwd });
        if (located !== undefined && typeof located.path === "string") {
          return dirname(located.path);
        }
      } catch {
        /* fall through to layout math */
      }
    }
    if (typeof persistence.root === "string" && header.cwd !== undefined) {
      return join(
        persistence.root,
        projectKey(header.cwd),
        encodeSegment(header.id),
      );
    }
  }
  return undefined;
}

/** True when `target` resolves inside `root` (traversal-safe rm guard). */
function containedIn(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Remove one session from every workspace account and from the archive set.
 *
 * Portable path (works on any stock host, no patches): the workspace entities
 * exposed by `workspaceRegistry.list()` carry a public `detachSession()`, and
 * the archive set lives in the already-open `workspace` storage domain — we
 * update the domain global directly and keep the registry's in-memory state
 * cache aligned so later registry writes cannot resurrect the id.
 *
 * When the host carries a patched registry exposing `removeSession` (the
 * serialized one-shot primitive), prefer it: it owns operation ordering.
 *
 * @returns true when any accounting held the session, false otherwise.
 */
async function removeFromRegistry(ctx, registry, sessionId) {
  if (registry === undefined) return false;
  if (typeof registry.removeSession === "function") {
    return await registry.removeSession(sessionId);
  }

  let held = false;

  // 1. Workspace account rows (public mutation primitive).
  let entities;
  try {
    entities = typeof registry.list === "function" ? registry.list() : [];
  } catch {
    entities = [];
  }
  for (const entity of entities) {
    const ids = entity?.record?.sessionIds;
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
    if (typeof entity.detachSession === "function") {
      await entity.detachSession(sessionId);
      held = true;
    }
  }

  // 2. Archive set (domain-global sync through the public storageDomain face).
  const storageDomain = ctx.get("storageDomain");
  const domain =
    storageDomain !== undefined && typeof storageDomain.get === "function"
      ? storageDomain.get("workspace")
      : undefined;
  if (domain?.global !== undefined && typeof domain.global.get === "function") {
    let state;
    try {
      state = domain.global.get();
    } catch {
      state = undefined;
    }
    const archived = Array.isArray(state?.archivedSessionIds)
      ? state.archivedSessionIds
      : [];
    if (archived.includes(sessionId)) {
      const next = { ...state, archivedSessionIds: archived.filter((id) => id !== sessionId) };
      if (typeof domain.global.set === "function") {
        await domain.global.set(next);
        held = true;
        // Keep the registry's cached state aligned so a later registry write
        // (e.g. archiving another session) spreads the new set, not the stale one.
        if (registry.state !== undefined) registry.state = next;
      }
    }
  }

  return held;
}

export function apply(ctx) {
  ctx.inject(["webServer"], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: "exact",
          path: "/api/session-delete",
          handler: async (request, response) => {
            if (request.method !== "POST") {
              response.writeHead(405, { allow: "POST" });
              response.end();
              return;
            }
            if (!sameOrigin(request)) {
              return sendJson(response, 403, { error: "untrusted origin" });
            }
            let body;
            try {
              body = await readJsonBody(request);
            } catch {
              return sendJson(response, 400, { error: "invalid request body" });
            }
            const sessionId = body?.sessionId;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
              return sendJson(response, 400, { error: "missing sessionId" });
            }

            try {
              const sessions = ctx.get("sessions");
              const agents = ctx.get("agents");
              const registry = ctx.get("workspaceRegistry");
              const persistence = ctx.get("sessionPersistence");

              const live = sessions?.get(sessionId);
              const agent = agents?.get(sessionId);

              if (agent !== undefined && agent.status === "running") {
                return sendJson(response, 409, {
                  error: "该对话正在运行，请先停止或等待完成后再删除",
                });
              }
              if (agent !== undefined && agent.inbox?.hasPending === true) {
                return sendJson(response, 409, {
                  error: "该对话还有待处理的交互，请先处理完成后再删除",
                });
              }

              let header = live !== undefined ? live.header : undefined;
              if (header === undefined && persistence !== undefined) {
                try {
                  header = (await persistence.list()).find(
                    (meta) => meta.id === sessionId,
                  );
                } catch {
                  /* persistence listing failure must not mask registry cleanup */
                }
              }

              if (live === undefined && header === undefined) {
                // Completely unknown: still sweep registry accounting.
                const held = await removeFromRegistry(
                  ctx,
                  registry,
                  sessionId,
                );
                if (!held) {
                  return sendJson(response, 404, { error: "session not found" });
                }
                return sendJson(response, 200, { ok: true });
              }

              // Live teardown: agent first (so a late prompt cannot revive the
              // session), then the session (emits session/disposed → persistence
              // retirement flush). Wait for the flush before touching files.
              if (agent !== undefined) {
                const entry =
                  typeof agents?.store?.get === "function"
                    ? agents.store.get(sessionId)
                    : undefined;
                if (entry !== undefined && typeof agents.detachEntered === "function") {
                  agents.detachEntered(entry);
                }
              }
              if (live !== undefined) {
                const entry =
                  typeof sessions?.store?.get === "function"
                    ? sessions.store.get(sessionId)
                    : undefined;
                if (entry !== undefined && typeof sessions.detachEntered === "function") {
                  sessions.detachEntered(entry);
                  const coordinator = persistence?.coordinator;
                  if (
                    coordinator !== undefined &&
                    typeof coordinator.waitForRetirement === "function"
                  ) {
                    await coordinator.waitForRetirement(sessionId);
                  }
                }
              }

              // Registry accounting (workspace rows + archive set).
              await removeFromRegistry(ctx, registry, sessionId);

              // Durable files, traversal-guarded against the backend root.
              const dir = sessionDirFor(persistence, header);
              let removedFiles = false;
              if (
                dir !== undefined &&
                persistence !== undefined &&
                typeof persistence.root === "string" &&
                containedIn(persistence.root, dir)
              ) {
                await rm(dir, { recursive: true, force: true });
                removedFiles = true;
              }

              return sendJson(response, 200, {
                ok: true,
                removedFiles,
              });
            } catch (error) {
              return sendJson(response, 500, {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      "dsh-session-delete: http route",
    );
  });
}
