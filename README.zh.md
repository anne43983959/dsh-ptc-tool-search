# PTC 工具搜索（本地 0.3.1）

基于 [hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) 的本地二次开发，只服务 DeepSeek Harness **0.2.1-rc.5 / 0.2.2-rc.1** 的 PTC 模式。

上游基线为 v0.1.1（2026-10-18）。本地版本增加了完整工具索引、显式卸载、16/24 容量例外锁、LRU 自动卸载、inventory/require 工具、常驻发现事实、0.2.2 PTC executor 识别，以及 v0.3 的永久槽位、紧凑可用清单和控制面装卸载提示。本包不发布到 npm。

- 实现与企划记录：保留在作者本地启动器工作区的 `docs/plans/dsh-ptc-tool-search/`（不在本仓库内）。
- 回滚：移除依赖与 bundle 条目后重启；启用前保留 profile 备份。

## 激活条件

插件在 `agent/created` 时只对 PTC agent 激活。满足任一条件即视为 PTC：

1. registry 仍暴露 `run_code`（0.2.1 行为）；
2. session header 的 `agentPreset` 为 `ptc`；
3. 当前 tool executor 的 `describe()` 返回 `run_code`（0.2.2：`run_code` 是 presentation transport，不在 registry 里）。

标准模式不受影响。插件加载前已经存在的 agent 保留旧工具面；重启后请新建 PTC agent。

激活后插件会：

- 为该 agent 建立完整工具目录（排除 `run_code`）；
- 用 `restrict({ allow: permanent })` 初始声明永久工具并隐藏其余工具；
- 注册 `tool_search`、`tool_unload`、`tool_inventory`、`tool_require` 四个 agent 级工具；
- 从会话事件维护 `turnCalled`、`lastCalled`、`exceptionLatched`、`required`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `tool_search({ query?, limit?, namesOnly? })` | 空 query 返回完整索引；有 query 时排序并加载匹配工具。`namesOnly: true` 只返回名字/分组，不返回描述、不加载。单次加载只受 headroom 限制。 |
| `tool_unload({ names? })` | 卸载指定工具或全部已加载工具；下一轮模型请求生效。 |
| `tool_inventory({})` | 只读快照：selected/permanent/loaded/availableCount/availableGroups/evicted/required/controlViolation、capacity、headroom、autoUnloadMax、exceptionLatched、memoryRead 可用性。 |
| `tool_require({ names?, clear? })` | pin 工具，使 inactivity 自动卸载跳过它们；显式 `tool_unload` 仍可移除。 |

## 容量规则

- 默认容量 16（`maxLoaded`）。
- 本轮内“当时已加载的工具全部至少被调用一次”后，例外锁生效，容量变为 24（`exceptionMax`）。
- `autoUnloadMax = exceptionLatched ? 0 : count(loaded - turnCalled)`。
- `headroom = max(0, capacity - selected.size)`；permanent 不占可变额度。
- 单次搜索只加载到剩余 headroom。
- 容量满时自动卸载最久未调用的旧工具，并在 `autoUnloaded` 中以 `reason: "inactivity"` 明示。
- 锁在下一轮 `turn/start` 重置；锁生效后新加载的工具不会撤销锁。

这些规则同时写入静态 `TOOL DISCOVERY CONTRACT` 描述，模型不需要先搜索一次才知道。永久工具始终声明、不进入 selected，不能运行期卸载。`tool_search` / `tool_unload` / `tool_require` 是 control-plane：单独一步调用，读返回值后结束本步，下一轮模型请求再使用新 SDK。

## 配置

`cordis.patch.yml` 插入行 `ptc-tool-search`：

| 键 | 默认值 | 含义 |
| --- | ---: | --- |
| `enabled` | `true` | 是否对新 PTC agent 启用发现。 |
| `maxLoaded` | `16` | 默认已加载 schema 容量，正整数。 |
| `exceptionMax` | `24` | 例外锁生效后的容量，必须 >= `maxLoaded`。 |
| `maxQueryChars` | `256` | query 最大长度，正整数。 |
| `maxDescriptionChars` | `160` | 索引中描述的最大长度，正整数。 |
| `permanentTools` | `pwsh, read, write, edit, memory_read`（存在才生效） | 高频永久工具；不占容量/headroom；最多 6 个。 |
| `maxPermanent` | `6` | permanent 配置上限，正整数。 |
| `requiredToolsBySkill` | `{}` | 技能名到工具名的映射；观察到该技能的 `skill` 调用时，按 `tool_require` 同一路径 pin 目录中存在的工具，未知工具名忽略。 |

没有热修改路径；改配置后必须重启实例。

## 安装（本地 link + bundle）

profile 必须同时有 link 依赖与 bundle 条目；只加依赖不会应用 `cordis.patch.yml`。

把 `<launcher>`、`<home>`、`<version>` 换成启动器数据目录、目标 home 与运行中的 DSH 版本：

```powershell
$launcher='<launcher>'
$home='<home>'
$version='<version>'
$bin="$launcher/versions/$version/node_modules/@deepseek-ai/dsh/lib/bin.js"
$store="$launcher/.pnpm-store"

$env:DSH_HOME=$home
node $bin plugin --profile web add "link:$launcher/plugins/dsh-ptc-tool-search" --config.store-dir=$store
```

然后把 `"@hrygo/dsh-ptc-tool-search"` 加入 profile 的 `dsh.profile.bundles`，重启，并新建 **PTC 会话**。

`engines.dsh` 为 `>=0.2.1-rc.5 <0.2.3-0`：0.2.1-rc.5 与 0.2.2-rc.1 通过，0.2.3-rc.1 / 0.3.0 被拒；不再需要精确版本豁免。

## 测试

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

共 25 个测试：21 个插件级（激活、索引、加载、锁、自动卸载、卸载、隔离、inventory、require、技能映射、永久槽位、namesOnly、控制面审计、schema 子集守卫）+ 4 个搜索排序测试。

沙箱会拦截 Node test runner 的子进程 spawn（`spawn EPERM`），因此在本工作区请直接执行上面的测试文件，不要用 `node --test`。

## 回滚

1. 停止实例。
2. 从 profile 的 `dependencies` 与 `dsh.profile.bundles` 移除 `@hrygo/dsh-ptc-tool-search`。
3. 需要时恢复安装前的 `package.json` / `pnpm-lock.yaml` 基线。
4. 重启，新建 PTC 会话确认 `tool_search` 消失。

启用前先备份 profile 的 `package.json` / `pnpm-lock.yaml`；回滚时恢复。

## 限制

- 只服务 PTC；标准/native agent 不变。
- 选择状态按 live agent 隔离，不跨 resume/restart 持久化。
- 不做工具组；完整索引是唯一目录。
- 安装/重启时已存在的 live agent 保留旧工具面。
- 不改变权限、沙箱或审批。

## 许可

MIT，沿用上游项目。
