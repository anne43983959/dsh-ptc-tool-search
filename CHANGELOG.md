# Changelog

## 0.2.1 — 2026-11-08

### Fixed

- Activate on DeepSeek Harness 0.2.2 PTC agents where `run_code` is supplied by the PTC tool executor and is no longer present in `ctx.tools.schemas(agent)`. The plugin now also recognises `agentPreset: "ptc"` and the selected executor's `describe()` output.
- Replace the exact `engines.dsh` pin with `>=0.2.1-rc.5 <0.2.3-0`, so 0.2.1-rc.5 and 0.2.2-rc.1 pass without a profile-level exact-version exemption.

### Added

- `requiredToolsBySkill` config mapping: pin catalog tools when a matching `skill` call is observed.

### Changed

- Add regression tests for the 0.2.2 registry shape, standard-agent non-activation, executor-based detection, and `requiredToolsBySkill` pinning (19 tests total).
- Rewrite README / README.zh.md for the local fork: activation, tools, capacity rules, configuration, install, tests, rollback, limitations.

## 0.2.0 — 2026-11-08

### Added

- Complete tool index with `catalogComplete`, `totalTools`, groups and one-line descriptions.
- `tool_unload({ names? })` for explicit unload.
- `tool_inventory({})` read-only snapshot.
- `tool_require({ names?, clear? })` pins that survive inactivity auto-unload.
- 16/24 capacity latch, `autoUnloadMax`, headroom-driven loading, LRU auto-unload with `autoUnloaded` warnings.
- Resident `TOOL DISCOVERY CONTRACT` facts in the tool descriptions.

## 0.1.1 — 2026-10-18

### Changed

- Replace the plugin icon with a transparent 36×36 code-search glyph, reviewed in both themes.
- Expand live GPT/Muse A/B coverage to repeated four-turn workflows with multiple tools and image generation; publish token, latency and charge-availability measurements.

Discovery runtime code and Harness compatibility are unchanged.

## 0.1.0 — 2026-10-18

### Added

- Per-agent PTC discovery through the official Harness scoped registry.
- Bounded lexical search with exact-name ranking and configurable result summaries.
- Existing policy enforcement and cleanup when an agent or plugin is disposed.
- English and Chinese display metadata, documentation and an original SVG icon.
- Tests and documented GPT/Muse compatibility and context measurements.

This initial public release supports Harness 0.2.1-rc.2. Selections are not persisted across recreated agents.
