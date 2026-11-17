# PTC Tool Search (local 0.4.0)

Local fork of [hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) for PTC-only progressive tool discovery on DeepSeek Harness **0.2.1-rc.5 / 0.2.2-rc.x**.

**0.4.0 is a breaking release.** Discovery no longer loads tools:

- a resident `tools:index` section names every registered tool (grouped, no descriptions);
- `tool_search` is read-only and returns only keyword matches that are **not loaded**, with descriptions;
- `tool_load` loads exact names, idempotently, with admission checks and optional pinning.

The upstream baseline is v0.1.1. This fork keeps the capacity latch, LRU eviction, inventory, pinning, skill
mapping, PTC activation detection, and the schema-subset guard. It is not published to npm.

## Activation

On `agent/created` the plugin activates only for PTC agents, recognised by any of:

1. the registry still exposes `run_code`;
2. the session header has `agentPreset: "ptc"`;
3. the selected executor describes `run_code`.

When active, the plugin builds a catalog of registered tools (excluding `run_code`), restricts the agent's global
tools to the permanent set plus loaded tools, registers `tool_search`, `tool_load`, `tool_unload`,
`tool_require`, and `tool_inventory`, and renders the resident index section.

## Tools

| Tool | Purpose |
| --- | --- |
| `tool_search({ query })` | Read-only. Returns keyword-matched tools that are **not loaded**, with descriptions, gated marks, and the activation skill. Empty query is rejected: the index is already in the SDK. `limit` and `namesOnly` are accepted but ignored (deprecated). |
| `tool_load({ names, pin? })` | Load by exact name (string or array). Idempotent (`alreadyLoaded`), partial success, per-call batch limit, LRU eviction, gated refusal with the activation skill. `pin: true` keeps tools through inactivity eviction. |
| `tool_unload({ names? })` | Unload named tools or every loaded tool. |
| `tool_require({ names?, clear? })` | Compatibility alias: pin loaded tools without loading. Prefer `tool_load({ pin: true })`. |
| `tool_inventory({})` | Read-only snapshot: selected/permanent/loaded/availableCount/availableGroups/evicted/required/gated/gatedSkills, admissionChecked, capacity/headroom/latch, and searched/loadCalls/refused/evicted counters. |

`tool_search`, `tool_load`, `tool_unload`, and `tool_require` are control-plane calls: call them alone in a
step, read the result, end the step, and use the new SDK on the next model request.

## Resident index

The `tools:index` section lists every registered tool, grouped by capability, plus a short discovery policy. It
contains no descriptions and no loaded/selected state, so its bytes stay stable across loads. Known gated tools
are marked `name[skill]`; gating is known either from the `gatedTools` config or from reconciliation (see below).

## Gating and admission

The host admits a tool to a step only when its registration condition (`when`) passes. The plugin cannot evaluate
`when` directly, so it uses two signals:

1. `gatedTools` config marks tools known to require an activation skill; `tool_load` refuses them.
2. Reconciliation: when a control-plane tool runs with `exec.toolSet`, the plugin compares the admitted set with
   `selected`; any selected tool missing from it is unloaded with `reason: "gated"`, recorded in `knownGated`,
   and refused on the next load. Invoking the matching skill clears those marks.

## Capacity rules

- Default capacity is 16 (`maxLoaded`); the turn latch raises it to 24 (`exceptionMax`) once every loaded tool has
  been called in the current turn.
- `headroom = max(0, capacity - selected.size)`; permanent tools do not consume the mutable quota.
- Only `tool_load` changes the loaded set. A single load is capped by `loadBatchMax` (default 5) and by headroom;
  over-capacity loads evict the oldest inactive tool (pinned tools excluded) and report `evicted`.
- Pinned tools (`pin` or `tool_require`) survive inactivity eviction; explicit unload still removes them.
- The latch resets at `turn/start`.

## Configuration

`cordis.patch.yml` inserts row `ptc-tool-search`:

| Key | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `true` | Enable discovery for new PTC agents. |
| `maxLoaded` | `16` | Mutable schema capacity. |
| `exceptionMax` | `24` | Capacity after the turn latch; must be >= `maxLoaded`. |
| `maxQueryChars` | `256` | Maximum search query length. |
| `maxDescriptionChars` | `160` | Reserved for compatibility; the index no longer carries descriptions. |
| `searchDescriptionChars` | `500` | Description length returned by `tool_search`; `0` returns the full text. |
| `loadBatchMax` | `5` | Maximum names loaded by one `tool_load` call. |
| `permanentTools` | `pwsh, read, write, edit, memory_read, skill` | Always-declared tools; max `maxPermanent`. |
| `maxPermanent` | `6` | Hard cap on permanent tools. |
| `requiredToolsBySkill` | `{}` | Skill name → tool names; invoked skills load and pin those tools. |
| `activationSkillByTool` | office tools → `office` | Skill hints for gated tools. |
| `gatedTools` | `{}` (deployment sets office tools) | Tool → activation skill; refused until the skill is invoked. |

Restart the instance to apply configuration changes.

## Install (local link + bundle)

The profile needs the link dependency and the bundle entry; the bundle applies `cordis.patch.yml`.

```powershell
$launcher='<launcher>'
$home='<home>'
$version='<version>'
$bin="$launcher/versions/$version/node_modules/@deepseek-ai/dsh/lib/bin.js"
$store="$launcher/.pnpm-store"

$env:DSH_HOME=$home
node $bin plugin --profile web add "link:$launcher/plugins/dsh-ptc-tool-search" --config.store-dir=$store
```

Then add `"@hrygo/dsh-ptc-tool-search"` to `dsh.profile.bundles`, restart, and create a new PTC session.

## Tests

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

29 tests: 20 plugin-level and 9 ranking tests. Run files directly; the sandbox blocks `node --test` child spawns.

## Rollback

The plugin directory is a git repository. The v0.3.1 baseline is the remote `origin/main` commit `be3f483`:

```powershell
git -C <plugin-dir> fetch origin
git -C <plugin-dir> reset --hard origin/main
```

Then restart the instance; no home data is involved. Alternatively remove the dependency and bundle entry.

## Limitations

- PTC only; standard/native agents are unchanged.
- Selection is per live agent and is not persisted across resume/restart.
- `when` cannot be evaluated directly; unconfigured gating is discovered only after a load attempt.
- The plugin does not change permissions, sandboxing, or approvals.

## License

MIT, inherited from the upstream project.
