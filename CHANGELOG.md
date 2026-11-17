# Changelog

## 0.4.0 — 2026-11-17

Breaking change: discovery no longer loads tools, and a resident index names every registered tool.

### Added

- Resident `tools:index` systemPrompt section: names grouped by capability, known gated tools marked with their
  activation skill, and a three-line discovery policy. No descriptions, no loaded state, no per-request churn.
- `tool_load({ names, pin? })`: exact-name loading, idempotent (`alreadyLoaded`), partial success,
  per-call batch limit, LRU eviction, gated refusal, and optional pinning.
- Admission reconciliation: when `exec.toolSet` is available, a selected tool missing from the admitted step view
  is unloaded with `reason: "gated"`, recorded in `knownGated`, and refused on the next load.
- Inventory now reports `gated`, `gatedSkills`, `admissionChecked`, and searched/loadCalls/refused/evicted counters.
- `gatedTools` config (tool → activation skill) for pre-marking known gated tools; `activationSkillByTool` hints.
- `skill` is now a permanent slot by default (5 → 6) so "check the skill catalog first" is always executable.

### Changed

- `tool_search` is read-only: returns only keyword matches that are not loaded, never loads, never counts against
  capacity, and no longer returns the whole catalog. Empty query is rejected.
- Search ranking uses word boundaries (so "vision" no longer matches "revision") and weights exact names above
  name tokens above description tokens.
- `tool_require` remains as a compatibility alias for pinning; prefer `tool_load({ pin: true })`.
- `requiredToolsBySkill` now loads (not only pins) the mapped tools when the skill is invoked, and clears matching
  gated marks.

### Tests

- 29 tests: 20 plugin-level (activation, index section, read-only search, load/idempotency/batch/capacity,
  gated refusal, reconcile discovery, skill activation, unload, pin, schema subset) and 9 ranking tests.

## 0.3.1 — 2026-11-09


### Fixed

- `tool_search` and `tool_inventory` output schemas no longer use an object-form `additionalProperties`. DeepSeek Harness 0.2.2 enforces a JSON-schema subset where `additionalProperties` must be a boolean; creating a session rejects the whole agent when any tool output schema falls outside it (`JsonSchemaError: ... availableGroups.additionalProperties must be a boolean`).
- `availableGroups` keeps its `{ group: count }` shape; counts still come from the plugin catalog and are integers at runtime.

### Added

- Schema-subset guard test: walks every registered output schema and enforces the host subset (boolean `additionalProperties`, one scalar `type`, declared `required` names, keyword whitelist).

### Tests

- 25 tests: 21 plugin-level and 4 search-ranking.

## 0.3.0 — 2026-11-09

### Added

- Permanent slots: a small configured permanentTools set (default pwsh, read, write, edit, memory_read, present-only; max 6) is always allowed, does not consume the 16/24 capacity, and is never auto-unloaded.
- tool_inventory exposes permanent, availableCount, availableGroups, controlViolation; loaded is the permanent+selected union.
- tool_search({ namesOnly: true }) returns a compact names/groups index without loading; notLoaded excludes permanent tools.
- Control-plane results (tool_search, tool_unload, tool_require) now carry controlPlane, nextRequest, and instruction; the static contract tells the model to call them alone and use the new SDK on the next request.
- Same-step control/business mixing is audited in controlViolation (warning only, not blocking).

### Tests

- 24 tests: 20 plugin-level and 4 search-ranking.

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