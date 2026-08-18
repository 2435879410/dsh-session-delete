# dsh-session-delete

[English](./README_EN.md)

给 DSH（DeepSeek Harness）左侧工作区栏的会话行菜单增加「删除对话」：**真正删除**会话（工作区账目 + 归档集 + 本地 jsonl 日志目录），而不是归档隐藏。同时支持 **web 端与 Desktop 端**，**无需改动应用本身**，装上即用。

## 特性

- 左侧栏会话行 `⋯` 菜单新增红色「删除对话」项 + 确认弹窗（中/英文案）
- 真正删除：工作区注册表、归档集、`~/.dsh/sessions/<项目>/<会话ID>/` 日志目录全部清理
- 安全防护：
  - 会话正在运行 / 有待处理交互 → 409 拒绝，绝不误删
  - 存活会话先摘除 agent → 摘除 session → 等待持久化退休 flush 完成后才删文件（日志不会被复活重写）
  - 文件删除带路径包含性校验（防越界）
  - 全部内部 API 带存在性守卫，宿主结构变化时优雅降级
- 删除的是当前打开的对话时，自动跳转到新建会话视图
- 纯 MIT，无运行时依赖

## 工作原理（无补丁方案）

- **host 侧**（`lib/index.js`）：注册 `POST /api/session-delete`，通过公开服务编排删除；
  注册表清理走公开的 `workspaceRegistry.list()` → `entity.detachSession()`，归档集通过
  `storageDomain.get("workspace")` 的 domain-global 同步（并同步注册表内存缓存，防止后续
  归档操作把已删会话复活）。
- **client 侧**（`lib/client.js`）：一份派生于
  [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `ui-workspace` 的
  工作区浏览器 fork（含删除菜单/弹窗/调用），以 **priority -1** 注册进 `sidebar.workspaces`
  槽位 —— 槽位系统按优先级选举渲染者，低优先级（-1）胜出并遮蔽内置浏览器，卸载插件即恢复原样。

## 安装

### Desktop 端

```bash
dsh plugin --profile desktop add "dsh-session-delete@github:2435879410/dsh-session-delete" --config.minimumReleaseAge=0
```

重启 DSH Desktop，左侧栏会话行 `⋯` 菜单即出现「删除对话」。

### Web 端

```bash
dsh plugin add "dsh-session-delete@github:2435879410/dsh-session-delete" --config.minimumReleaseAge=0
```

刷新页面即可。

> 若 24 小时内新发布导致 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，保留
> `--config.minimumReleaseAge=0` 重试即可。

### 卸载

```bash
dsh plugin --profile desktop remove dsh-session-delete   # Desktop
dsh plugin remove dsh-session-delete                      # Web
```

## 验证

1. 重启后打开 `http://127.0.0.1:<port>/`，左侧栏任一会话行 `⋯` → 「删除对话」；
2. 确认后该行消失，`~/.dsh/sessions/<项目>/<会话ID>/` 目录被删除；
3. 也可直接调用接口：`curl -X POST /api/session-delete -H "Origin: http://127.0.0.1:<port>" -H "content-type: application/json" -d '{"sessionId":"..."}'`。

## 局限性 / 说明

- 依赖 DSH 内部服务（session/agent/workspace/persistence 的具体结构），未来 DSH 大版本
  升级若改动内部结构，插件的守卫会使其降级而非崩溃；如出现功能失效请提 issue。
- 客户端 fork 基于 `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6` 编译产物派生，
  上游更新内置浏览器的新特性不会自动出现在 fork 中（删除功能本身不受影响）。

## License

MIT。`lib/client.js` 派生自 deepseek-harness 的 `ui-workspace`（MIT），详见 [LICENSE](./LICENSE)。
