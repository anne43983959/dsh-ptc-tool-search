# PTC 工具搜索（本地 0.2.1）

基于 [hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) 的本地二次开发，只服务 DeepSeek Harness **0.2.1-rc.5 / 0.2.2-rc.1** 的 PTC 模式。

上游基线为 v0.1.1（2026-10-18）。本地版本增加了完整工具索引、显式卸载、16/24 容量例外锁、LRU 自动卸载、inventory/require 工具、常驻发现事实，以及对 0.2.2 PTC executor 架构的识别。本包不发布到 npm。

- 实现与企划记录：[docs/plans/dsh-ptc-tool-search/README.md](../../docs/plans/dsh-ptc-tool-search/README.md)
- 版本记录与回滚：[docs/plans/dsh-ptc-tool-search/ROLLBACK-RELEASE.md](../../docs/plans/dsh-ptc-tool-search/ROLLBACK-RELEASE.md)

## 激活条件

插件在 `agent/created` 时只对 PTC agent 激活。满足任一条件即视为 PTC：

1. registry 仍暴露 `run_code`（0.2.1 行为）；
2. session header 的 `agentPreset` 为 `ptc`；
3. 当前 tool executor 的 `describe()` 返回 `run_code`（0.2.2：`run_code` 是 presentation transport，不在 registry 里）。

标准模式不受影响。插件加载前已经存在的 agent 保留旧工具面；重启后请新建 PTC agent。

激活后插件会：

- 为该 agent 建立完整工具目录（排除 `run_code`）；
- 用 `restrict({ allow: [] })` 初始隐藏全局工具；
- 注册 `tool_search`、`tool_unload`、`tool_inventory`、`tool_require` 四个 agent 级工具；
- 从会话事件维护 `turnCalled`、`lastCalled`、`exceptionLatched`、`required`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `tool_search({ query?, limit? })` | 空 query 返回完整索引；有 query 时排序并加载匹配工具。单次加载只受 headroom 限制，不设固定条数。 |
| `tool_unload({ names? })` | 卸载指定工具或全部已加载工具；下一轮模型请求生效。 |
| `tool_inventory({})` | 只读快照：selected/loaded/evicted/required、capacity、headroom、autoUnloadMax、exceptionLatched、memoryRead 可用性。 |
| `tool_require({ names?, clear? })` | pin 工具，使 inactivity 自动卸载跳过它们；显式 `tool_unload` 仍可移除。 |

## 容量规则

- 默认容量 16（`maxLoaded`）。
- 本轮内“当时已加载的工具全部至少被调用一次”后，例外锁生效，容量变为 24（`exceptionMax`）。
- `autoUnloadMax = exceptionLatched ? 0 : count(loaded - turnCalled)`。
- `headroom = max(0, capacity - loaded.size)`。
- 单次搜索只加载到剩余 headroom。
- 容量满时自动卸载最久未调用的旧工具，并在 `autoUnloaded` 中以 `reason: "inactivity"` 明示。
- 锁在下一轮 `turn/start` 重置；锁生效后新加载的工具不会撤销锁。

这些规则同时写入静态 `TOOL DISCOVERY CONTRACT` 描述，模型不需要先搜索一次才知道。

## 配置

`cordis.patch.yml` 插入行 `ptc-tool-search`：

| 键 | 默认值 | 含义 |
| --- | ---: | --- |
| `enabled` | `true` | 是否对新 PTC agent 启用发现。 |
| `maxLoaded` | `16` | 默认已加载 schema 容量，正整数。 |
| `exceptionMax` | `24` | 例外锁生效后的容量，必须 >= `maxLoaded`。 |
| `maxQueryChars` | `256` | query 最大长度，正整数。 |
| `maxDescriptionChars` | `160` | 索引中描述的最大长度，正整数。 |
| `requiredToolsBySkill` | `{}` | 技能名到工具名的映射；观察到该技能的 `skill` 调用时，按 `tool_require` 同一路径 pin 目录中存在的工具，未知工具名忽略。 |

没有热修改路径；改配置后必须重启实例。

## 安装（本地 link + bundle）

profile 必须同时有 link 依赖与 bundle 条目；只加依赖不会应用 `cordis.patch.yml`。

```powershell
$env:DSH_HOME='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1'
$bin='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/versions/0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js'
$store='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/.pnpm-store'

node $bin plugin --profile web add 'link:C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/plugins/dsh-ptc-tool-search' --config.store-dir=$store
```

然后把 `"@hrygo/dsh-ptc-tool-search"` 加入 profile 的 `dsh.profile.bundles`，重启，并新建 **PTC 会话**。当前 022 web profile 就是这样安装的。

`engines.dsh` 为 `>=0.2.1-rc.5 <0.2.3-0`：0.2.1-rc.5 与 0.2.2-rc.1 通过，0.2.3-rc.1 / 0.3.0 被拒；不再需要精确版本豁免。

## 测试

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

共 19 个测试：15 个插件级（激活、索引、加载、锁、自动卸载、卸载、隔离、inventory、require、技能映射）+ 4 个搜索排序测试。

沙箱会拦截 Node test runner 的子进程 spawn（`spawn EPERM`），因此在本工作区请直接执行上面的测试文件，不要用 `node --test`。

## 回滚

1. 停止实例。
2. 从 profile 的 `dependencies` 与 `dsh.profile.bundles` 移除 `@hrygo/dsh-ptc-tool-search`。
3. 需要时恢复安装前的 `package.json` / `pnpm-lock.yaml` 基线。
4. 重启，新建 PTC 会话确认 `tool_search` 消失。

022 修复前基线在 `.sandbox/plugin-fix-20261108/`；021 安装基线在 `.sandbox/021-rollback-20261108-124232`。

## 限制

- 只服务 PTC；标准/native agent 不变。
- 选择状态按 live agent 隔离，不跨 resume/restart 持久化。
- 不做工具组；完整索引是唯一目录。
- 安装/重启时已存在的 live agent 保留旧工具面。
- 不改变权限、沙箱或审批。

## 许可

MIT，沿用上游项目。
