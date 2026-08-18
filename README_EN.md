# dsh-session-delete

[中文](./README.md)

Adds a **Delete conversation** action to the session row menu in DSH's left workspace sidebar — a REAL delete (workspace accounting + archive set + the local JSONL log directory), not just archiving. Works on **both web and Desktop**, with **zero app patching**.

## Features

- Red "Delete conversation" item in the session row `⋯` menu + confirmation dialog (zh/en)
- Real deletion: workspace registry, archive set, and `~/.dsh/sessions/<project>/<sessionId>/` are all cleaned up
- Safety:
  - Running sessions / sessions with pending interactions are refused with 409 — never force-deleted
  - Live sessions are torn down in order: agent → session → wait for the persistence retirement flush to complete before files are touched (the log cannot be resurrected by a late write)
  - Path-containment guard on file deletion (no traversal)
  - Every internal API access is capability-guarded: unknown host layouts degrade gracefully instead of crashing
- Deleting the currently open conversation navigates to the new-session view automatically
- Pure MIT, no runtime dependencies

## How it works (no-patch design)

- **Host** (`lib/index.js`): registers `POST /api/session-delete` and orchestrates the deletion
  through public services. Registry cleanup uses the public `workspaceRegistry.list()` →
  `entity.detachSession()`; the archive set is synced through the already-open workspace
  storage domain (`storageDomain.get("workspace")` domain-global), keeping the registry's
  in-memory state aligned so later archive operations cannot resurrect the deleted id.
- **Client** (`lib/client.js`): a fork of the `ui-workspace` browser from
  [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) with the delete
  menu/dialog/wiring, registered into the `sidebar.workspaces` slot at **priority -1** —
  the slot system elects the lowest priority, so the fork shadows the built-in browser;
  uninstalling the plugin restores the original.

## Install

### Desktop

```bash
dsh plugin --profile desktop add "dsh-session-delete@github:2435879410/dsh-session-delete" --config.minimumReleaseAge=0
```

Restart DSH Desktop — the `⋯` menu on every session row now has "Delete conversation".

### Web

```bash
dsh plugin add "dsh-session-delete@github:2435879410/dsh-session-delete" --config.minimumReleaseAge=0
```

Refresh the page.

> If a <24h-old release trips `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, keep
> `--config.minimumReleaseAge=0` and retry.

### Uninstall

```bash
dsh plugin --profile desktop remove dsh-session-delete   # Desktop
dsh plugin remove dsh-session-delete                      # Web
```

## Verify

1. Open `http://127.0.0.1:<port>/` after restart; use `⋯` → "Delete conversation" on any session row.
2. The row disappears and `~/.dsh/sessions/<project>/<sessionId>/` is removed.
3. Or call the endpoint directly:
   `curl -X POST /api/session-delete -H "Origin: http://127.0.0.1:<port>" -H "content-type: application/json" -d '{"sessionId":"..."}'`.

## Limitations

- Depends on DSH's internal service shapes (session/agent/workspace/persistence). If a future
  DSH major version changes them, the guards make the plugin degrade instead of crash — please
  open an issue if the feature stops working.
- The client fork derives from the compiled
  `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6` bundle; new built-in browser features from
  upstream releases will not appear in the fork automatically (deletion itself is unaffected).

## License

MIT. `lib/client.js` derives from deepseek-harness's `ui-workspace` (MIT) — see [LICENSE](./LICENSE).
