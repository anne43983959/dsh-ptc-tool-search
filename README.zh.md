# PTC Tool Search（本地 0.4.0）

[hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) 的本地分支，用于 DeepSeek Harness
**0.2.1-rc.5 / 0.2.2-rc.x** 的 PTC 渐进式工具发现。

**0.4.0 是破坏性变更**：搜索不再装载工具。

- 常驻 `tools:index` section 列出全部已注册工具（按组、无描述）；
- `tool_search` 只读，只返回“关键词命中且未装载”的工具及描述；
- `tool_load` 按精确名装载，幂等、带准入检查，可 pin。

上游基线为 v0.1.1。本分支保留容量闩锁、LRU 淘汰、inventory、pin、技能映射、PTC 激活判定与 schema 子集守卫。
不发布到 npm。

## 激活

`agent/created` 时只对 PTC agent 生效，判定为以下任一：

1. 注册表仍暴露 `run_code`；
2. 会话头 `agentPreset: "ptc"`；
3. 选中的执行器 describe 出 `run_code`。

激活后：构建注册目录（排除 `run_code`）、把全局工具收窄到 permanent + 已装载、注册
`tool_search` / `tool_load` / `tool_unload` / `tool_require` / `tool_inventory`，并渲染常驻索引 section。

## 工具

| 工具 | 用途 |
| --- | --- |
| `tool_search({ query })` | 只读。返回关键词命中且**未装载**的工具与描述、gated 标记、激活技能。空查询报错（索引已在 SDK 中）。`limit` / `namesOnly` 接受但忽略（deprecated）。 |
| `tool_load({ names, pin? })` | 按精确名装载（字符串或数组）。幂等（`alreadyLoaded`）、部分成功、单次批量上限、LRU 淘汰、gated 拒绝并给技能。`pin: true` 防非活动淘汰。 |
| `tool_unload({ names? })` | 卸载指定工具或全部已装载工具。 |
| `tool_require({ names?, clear? })` | 兼容别名：只钉不装。优先用 `tool_load({ pin: true })`。 |
| `tool_inventory({})` | 只读快照：selected/permanent/loaded/availableCount/availableGroups/evicted/required/gated/gatedSkills、admissionChecked、容量/水位/闩锁、searched/loadCalls/refused/evicted 计数。 |

`tool_search` / `tool_load` / `tool_unload` / `tool_require` 是控制面调用：单独占一步，读完结果结束本步，
下一次模型请求才带新 SDK。

## 常驻索引

`tools:index` 按组列出全部已注册工具，并附三行发现策略。不含描述、不含 loaded 状态，故字节稳定、加载后不变。
已知 gated 工具标为 `name[skill]`；gated 来源见下一节。

## 准入与 gated

宿主只在注册条件 `when` 通过时把工具放进该步的准入集合。插件无法直接求值 `when`，用两条信号：

1. `gatedTools` 配置标记“需要技能才能装载”的工具，`tool_load` 直接拒绝；
2. 对账：控制面调用带 `exec.toolSet` 时，比较准入集合与 `selected`；已装载却不在准入集合里的工具以
   `reason: "gated"` 卸载，记入 `knownGated`，下次装载拒绝。调用对应技能会清除这些标记。

## 容量规则

- 默认容量 16（`maxLoaded`）；本回合内每个已装载工具都被调用过后，闩锁把容量提到 24（`exceptionMax`）。
- `headroom = max(0, capacity - selected.size)`；permanent 不占可变配额。
- 只有 `tool_load` 改变装载集合；单次受 `loadBatchMax`（默认 5）与 headroom 限制；超容量时淘汰最久未调用的
  非 pin 工具并在 `evicted` 里报告。
- pin 工具（`pin` 或 `tool_require`）不会被非活动淘汰；显式 unload 仍可移除。
- 闩锁在 `turn/start` 复位。

## 配置

`cordis.patch.yml` 插入 `ptc-tool-search` 行：

| 键 | 默认 | 含义 |
| --- | ---: | --- |
| `enabled` | `true` | 是否为新的 PTC agent 启用。 |
| `maxLoaded` | `16` | 可变 schema 容量。 |
| `exceptionMax` | `24` | 闩锁后的容量，需 >= `maxLoaded`。 |
| `maxQueryChars` | `256` | 查询长度上限。 |
| `maxDescriptionChars` | `160` | 兼容保留；索引已不带描述。 |
| `searchDescriptionChars` | `500` | 搜索返回的描述长度；`0` 为全文。 |
| `loadBatchMax` | `5` | 单次 `tool_load` 的名字上限。 |
| `permanentTools` | `pwsh, read, write, edit, memory_read, skill` | 常驻工具，上限 `maxPermanent`。 |
| `maxPermanent` | `6` | 常驻工具硬上限。 |
| `requiredToolsBySkill` | `{}` | 技能名 → 工具名；技能调用时自动装载并 pin。 |
| `activationSkillByTool` | office 工具 → `office` | gated 工具的技能提示。 |
| `gatedTools` | `{}`（本机部署配置 office 三件） | 工具 → 激活技能；技能调用前拒绝装载。 |

配置变更需重启实例。

## 安装（本地 link + bundle）

profile 需要 link 依赖与 bundle 条目；bundle 负责应用 `cordis.patch.yml`。

```powershell
$launcher='<launcher>'
$home='<home>'
$version='<version>'
$bin="$launcher/versions/$version/node_modules/@deepseek-ai/dsh/lib/bin.js"
$store="$launcher/.pnpm-store"

$env:DSH_HOME=$home
node $bin plugin --profile web add "link:$launcher/plugins/dsh-ptc-tool-search" --config.store-dir=$store
```

然后加入 `dsh.profile.bundles`，重启，新建 PTC 会话。

## 测试

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

29 个测试：20 个插件级 + 9 个排序测试。沙箱禁止 `node --test` 子进程，直接跑文件。

## 回滚

插件目录是 git 仓库，v0.3.1 基线是远端 `origin/main` 的 `be3f483`：

```powershell
git -C <plugin-dir> fetch origin
git -C <plugin-dir> reset --hard origin/main
```

随后重启实例；不涉及 home 数据。

## 限制

- 仅 PTC；标准/native agent 不受影响。
- 选择按存活 agent 保存，不跨 resume/重启持久化。
- `when` 无法直接求值；未配置的 gated 只能装载后靠对账发现。
- 不改变权限、沙箱与审批。

## License

MIT，继承上游。
