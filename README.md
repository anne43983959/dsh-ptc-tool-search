# PTC Tool Search (local 0.2.1)

Local fork of [hrygo/dsh-ptc-tool-search](https://github.com/hrygo/dsh-ptc-tool-search) for PTC-only progressive tool discovery on DeepSeek Harness **0.2.1-rc.5 / 0.2.2-rc.1**.

The upstream baseline is v0.1.1 (2026-10-18). This local fork adds a complete tool index, explicit unloading, the 16/24 capacity latch, LRU auto-unload, inventory/require tools, resident discovery facts, and PTC detection for the 0.2.2 executor architecture. It is not published to npm.

- Implementation record: [docs/plans/dsh-ptc-tool-search/README.md](../../docs/plans/dsh-ptc-tool-search/README.md)
- Version record and rollback: [docs/plans/dsh-ptc-tool-search/ROLLBACK-RELEASE.md](../../docs/plans/dsh-ptc-tool-search/ROLLBACK-RELEASE.md)

## Activation

On `agent/created` the plugin activates only for PTC agents. A PTC agent is recognised by any of:

1. the registry still exposes `run_code` (0.2.1 behaviour);
2. the session header has `agentPreset: "ptc"`;
3. the selected tool executor describes `run_code` (0.2.2, where `run_code` is a presentation transport rather than a registered tool).

Standard/native agents are not affected. An agent that existed before the plugin was loaded keeps its old tool surface; create a new PTC agent after restart.

When active, the plugin:

- builds a complete catalog of the tools visible to that agent (excluding `run_code`);
- restricts the agent's global tools to the selected set (`allow: []` initially);
- registers `tool_search`, `tool_unload`, `tool_inventory`, and `tool_require` as agent-scoped tools;
- tracks `turnCalled`, `lastCalled`, `exceptionLatched`, and `required` from session events.

## Tools

| Tool | Purpose |
| --- | --- |
| `tool_search({ query?, limit? })` | Return the complete index (empty query) or rank/load matching tools. Loading is limited by headroom, not by a fixed result count. |
| `tool_unload({ names? })` | Unload named tools or every loaded tool. Applies to the next model request. |
| `tool_inventory({})` | Read-only snapshot: selected/loaded/evicted/required, capacity, headroom, autoUnloadMax, exceptionLatched, memoryRead availability. |
| `tool_require({ names?, clear? })` | Pin tools so inactivity auto-unload never selects them. Explicit `tool_unload` still removes them. |

## Capacity rules

- Default capacity is 16 (`maxLoaded`).
- When every tool loaded at that moment has been called in the current turn, the exception latch turns on and capacity becomes 24 (`exceptionMax`).
- `autoUnloadMax = exceptionLatched ? 0 : count(loaded - turnCalled)`.
- `headroom = max(0, capacity - loaded.size)`.
- A single search loads only into the remaining headroom.
- When capacity is full, the oldest last-called old tool is auto-unloaded and reported in `autoUnloaded` with `reason: "inactivity"`.
- The latch resets at the next `turn/start`; tools loaded after the latch was set do not clear it.

The same rules are embedded in the static `TOOL DISCOVERY CONTRACT` description so the model does not learn them only from a search result.

## Configuration

`cordis.patch.yml` inserts row `ptc-tool-search`:

| Key | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `true` | Enable discovery for new PTC agents. |
| `maxLoaded` | `16` | Default loaded-schema capacity; positive integer. |
| `exceptionMax` | `24` | Capacity after the turn exception latch; must be >= `maxLoaded`. |
| `maxQueryChars` | `256` | Maximum query length; positive integer. |
| `maxDescriptionChars` | `160` | Maximum description length in the index; positive integer. |
| `requiredToolsBySkill` | `{}` | Map skill name to tool names; when a `skill` call names that skill, the listed catalog tools are pinned via the same path as `tool_require`. Unknown tool names are ignored. |

There is no hot-reload path: restart the instance to apply configuration changes.

## Install (local link + bundle)

The profile must contain both the link dependency and the bundle entry; the bundle entry is what applies `cordis.patch.yml`.

```powershell
$env:DSH_HOME='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1'
$bin='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/versions/0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js'
$store='C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/.pnpm-store'

node $bin plugin --profile web add 'link:C:/Users/High4/AppData/Roaming/in.dsh-plug.dsh-launcher/plugins/dsh-ptc-tool-search' --config.store-dir=$store
```

Then add `"@hrygo/dsh-ptc-tool-search"` to the profile's `dsh.profile.bundles` array, restart, and create a **new PTC session**. The current 022 web profile is installed this way.

`engines.dsh` is `>=0.2.1-rc.5 <0.2.3-0`. It passes 0.2.1-rc.5 and 0.2.2-rc.1 and is rejected by 0.2.3-rc.1 / 0.3.0 (no exact-version exemption is required).

## Tests

```powershell
node tests/plugin.test.js
node tests/search.test.js
node --check index.js
node --check search.js
```

19 tests: 15 plugin-level (activation, index, loading, latch, auto-unload, unload, isolation, inventory, require, skill mapping) and 4 search-ranking tests.

The sandbox blocks the Node test runner's child-process spawn (`spawn EPERM`), so run each test file directly as above rather than `node --test` inside this workspace.

## Rollback

1. Stop the instance.
2. Remove `@hrygo/dsh-ptc-tool-search` from the profile's `dependencies` and `dsh.profile.bundles`.
3. Restore the pre-install `package.json` / `pnpm-lock.yaml` baseline if needed.
4. Restart and verify a new PTC session no longer has `tool_search`.

The 022 pre-fix baseline is `.sandbox/plugin-fix-20261108/`; the 021 install baseline is `.sandbox/021-rollback-20261108-124232`.

## Limitations

- PTC only; standard/native agents are unchanged.
- Selection is per live agent and is not persisted across resume/restart.
- No tool groups; the complete index is the only catalog.
- Existing live agents at install/restart time keep their previous surface.
- The plugin does not change permissions, sandboxing, or approvals.

## License

MIT, inherited from the upstream project.
