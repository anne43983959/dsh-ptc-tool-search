# PTC Tool Search (local 0.3.1)

Local fork of [hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) for PTC-only progressive tool discovery on DeepSeek Harness **0.2.1-rc.5 / 0.2.2-rc.1**.

The upstream baseline is v0.1.1 (2026-10-18). This local fork adds a complete tool index, explicit unloading, the 16/24 capacity latch, LRU auto-unload, inventory/require tools, resident discovery facts, PTC detection for the 0.2.2 executor architecture, v0.3 permanent slots for high-frequency base tools, a compact available-tool list, and control-plane loading guidance. It is not published to npm.

- Development record: kept in the author's launcher workspace under `docs/plans/dsh-ptc-tool-search/` (not part of this repository).
- Rollback: remove the dependency and bundle entry, then restart; keep a pre-install profile backup.

## Activation

On `agent/created` the plugin activates only for PTC agents. A PTC agent is recognised by any of:

1. the registry still exposes `run_code` (0.2.1 behaviour);
2. the session header has `agentPreset: "ptc"`;
3. the selected tool executor describes `run_code` (0.2.2, where `run_code` is a presentation transport rather than a registered tool).

Standard/native agents are not affected. An agent that existed before the plugin was loaded keeps its old tool surface; create a new PTC agent after restart.

When active, the plugin:

- builds a complete catalog of the tools visible to that agent (excluding `run_code`);
- restricts the agent's global tools to the selected set plus the configured permanent set (`allow: permanent` initially);
- registers `tool_search`, `tool_unload`, `tool_inventory`, and `tool_require` as agent-scoped tools;
- tracks `turnCalled`, `lastCalled`, `exceptionLatched`, and `required` from session events.

## Tools

| Tool | Purpose |
| --- | --- |
| `tool_search({ query?, limit?, namesOnly? })` | Return the complete index (empty query) or rank/load matching tools. `namesOnly: true` returns names/groups without descriptions and loads nothing. Loading is limited by headroom, not by a fixed result count. |
| `tool_unload({ names? })` | Unload named tools or every loaded tool. Applies to the next model request. |
| `tool_inventory({})` | Read-only snapshot: selected/permanent/loaded/availableCount/availableGroups/evicted/required/controlViolation, capacity, headroom, autoUnloadMax, exceptionLatched, memoryRead availability. |
| `tool_require({ names?, clear? })` | Pin tools so inactivity auto-unload never selects them. Explicit `tool_unload` still removes them. |

## Capacity rules

- Default capacity is 16 (`maxLoaded`).
- When every tool loaded at that moment has been called in the current turn, the exception latch turns on and capacity becomes 24 (`exceptionMax`).
- `autoUnloadMax = exceptionLatched ? 0 : count(loaded - turnCalled)`.
- `headroom = max(0, capacity - selected.size)`; permanent tools do not consume the mutable quota.
- A single search loads only into the remaining headroom.
- When capacity is full, the oldest last-called old tool is auto-unloaded and reported in `autoUnloaded` with `reason: "inactivity"`.
- The latch resets at the next `turn/start`; tools loaded after the latch was set do not clear it.

The same rules are embedded in the static `TOOL DISCOVERY CONTRACT` description so the model does not learn them only from a search result. Permanent tools are always declared; they are not selected and cannot be unloaded at runtime. `tool_search` / `tool_unload` / `tool_require` are control-plane calls: make them alone in a step, read the result, end the step, and use the new SDK on the next model request.

## Configuration

`cordis.patch.yml` inserts row `ptc-tool-search`:

| Key | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `true` | Enable discovery for new PTC agents. |
| `maxLoaded` | `16` | Default loaded-schema capacity; positive integer. |
| `exceptionMax` | `24` | Capacity after the turn exception latch; must be >= `maxLoaded`. |
| `maxQueryChars` | `256` | Maximum query length; positive integer. |
| `maxDescriptionChars` | `160` | Maximum description length in the index; positive integer. |
| `permanentTools` | `pwsh, read, write, edit, memory_read` (present only) | Always-declared high-frequency tools; do not count toward capacity/headroom; max 6. |
| `maxPermanent` | `6` | Hard cap on configured permanent tools; positive integer. |
| `requiredToolsBySkill` | `{}` | Map skill name to tool names; when a `skill` call names that skill, the listed catalog tools are pinned via the same path as `tool_require`. Unknown tool names are ignored. |

There is no hot-reload path: restart the instance to apply configuration changes.

## Install (local link + bundle)

The profile must contain both the link dependency and the bundle entry; the bundle entry is what applies `cordis.patch.yml`.

Replace `<launcher>`, `<home>`, and `<version>` with the launcher data directory, the target home, and the running DSH version:

```powershell
$launcher='<launcher>'
$home='<home>'
$version='<version>'
$bin="$launcher/versions/$version/node_modules/@deepseek-ai/dsh/lib/bin.js"
$store="$launcher/.pnpm-store"

$env:DSH_HOME=$home
node $bin plugin --profile web add "link:$launcher/plugins/dsh-ptc-tool-search" --config.store-dir=$store
```

Then add `"@hrygo/dsh-ptc-tool-search"` to the profile's `dsh.profile.bundles` array, restart, and create a **new PTC session**.

`engines.dsh` is `>=0.2.1-rc.5 <0.2.3-0`. It passes 0.2.1-rc.5 and 0.2.2-rc.1 and is rejected by 0.2.3-rc.1 / 0.3.0 (no exact-version exemption is required).

## Tests

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

25 tests: 21 plugin-level (activation, index, loading, latch, auto-unload, unload, isolation, inventory, require, skill mapping, permanent slots, namesOnly, control-plane audit, schema-subset guard) and 4 search-ranking tests.

The sandbox blocks the Node test runner's child-process spawn (`spawn EPERM`), so run each test file directly as above rather than `node --test` inside this workspace.

## Rollback

1. Stop the instance.
2. Remove `@hrygo/dsh-ptc-tool-search` from the profile's `dependencies` and `dsh.profile.bundles`.
3. Restore the pre-install `package.json` / `pnpm-lock.yaml` baseline if needed.
4. Restart and verify a new PTC session no longer has `tool_search`.

Keep a copy of the pre-install profile (`package.json` / `pnpm-lock.yaml`) before enabling the plugin; restore it to roll back.

## Limitations

- PTC only; standard/native agents are unchanged.
- Selection is per live agent and is not persisted across resume/restart.
- No tool groups; the complete index is the only catalog.
- Existing live agents at install/restart time keep their previous surface.
- The plugin does not change permissions, sandboxing, or approvals.

## License

MIT, inherited from the upstream project.
