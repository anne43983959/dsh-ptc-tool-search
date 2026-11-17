import { rankTools } from './search.js';

export const name = '@hrygo/dsh-ptc-tool-search';
export const inject = ['tools', 'agents', 'systemPrompt'];

const BASE_CAPACITY = 16;
const DEFAULT_EXCEPTION = 24;
const DEFAULT_PERMANENT = ['pwsh', 'read', 'write', 'edit', 'memory_read', 'skill'];
const DEFAULT_LOAD_BATCH = 5;
const DEFAULT_SEARCH_DESCRIPTION_CHARS = 500;
const DEFAULT_ACTIVATION_SKILLS = {
  office_render: 'office',
  office_convert: 'office',
  office_recalculate: 'office',
};
const CONTROL_TOOLS = new Set(['tool_search', 'tool_load', 'tool_unload', 'tool_require']);

const GROUPS = [
  ['word', /^(word_|office_.*docx|office_.*word)/i],
  ['excel', /^(excel_|office_.*xlsx|office_.*excel)/i],
  ['ppt', /^(ppt_|office_.*pptx|office_.*ppt)/i],
  ['web', /^(web_|ego_)/i],
  ['team', /^(team_|send_message$|list_agents$|wait_agent$|spawn_teammate$|subagent$|subagent_fork$|interrupt_agent$)/i],
  ['media', /^(vision_|read_image$|generate_image$|comfyui)/i],
  ['jobs', /^job_/i],
  ['shell', /^(pwsh$|bash$|working_directory$)/i],
  ['file', /^(read$|write$|edit$|edit_run_code$|glob$|grep$|str_replace_editor$)/i],
  ['orchestration', /^(skill$|skill_|todo_write$|present$|ask_user_question$|create_goal$|get_goal$|update_goal$)/i],
];

function groupOf(name) {
  for (const [group, re] of GROUPS) {
    if (re.test(name)) return group;
  }
  return 'singleton';
}

function sessionIdOf(scope) {
  return scope?.session?.header?.id ?? scope?.header?.id ?? scope?.id ?? '';
}

function skillNameFromArguments(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  return typeof args?.name === 'string' ? args.name : '';
}

function nowCapacity(state, config) {
  return state.exceptionLatched ? config.exceptionMax : config.maxLoaded;
}

function oldTools(state) {
  return [...state.selected].filter(name => !state.turnLoaded.has(name));
}

function autoUnloadMaxOf(state) {
  if (state.exceptionLatched) return 0;
  return Math.max(1, [...state.selected].filter(name => !state.required.has(name) && !state.turnCalled.has(name)).length);
}

function headroomOf(state, config) {
  return Math.max(0, nowCapacity(state, config) - state.selected.size);
}

function lastCall(state, name) {
  return state.lastCalled.get(name)?.seq ?? -1;
}

function sortByOldest(state, names) {
  return [...names].sort((a, b) => lastCall(state, a) - lastCall(state, b) || a.localeCompare(b));
}

function applyRestriction(state) {
  const replacement = state.agent.ctx.tools.restrict({ allow: [...state.permanent, ...state.selected] });
  if (typeof state.restriction === 'function') state.restriction();
  state.restriction = replacement;
}

function unloadNames(state, names, reason, resetLatch = true) {
  const removed = [];
  for (const name of names) {
    if (!state.selected.has(name)) continue;
    state.selected.delete(name);
    state.lastCalled.delete(name);
    state.turnCalled.delete(name);
    state.turnLoaded.delete(name);
    state.required.delete(name);
    removed.push({
      name,
      lastCalledTurn: -1,
      lastCalledStep: -1,
      reason,
      message: reason === 'inactivity'
        ? 'Unloaded after a full turn without a call'
        : reason === 'gated'
          ? 'Unloaded because the tool is gated by its activation condition'
          : 'Unloaded explicitly',
    });
  }
  if (resetLatch && state.selected.size === 0) state.exceptionLatched = false;
  applyRestriction(state);
  return removed;
}

function ensureRoom(state, wanted, config) {
  const autoUnloaded = [];
  let guard = 0;
  while (state.selected.size + wanted > nowCapacity(state, config) && guard < 100) {
    guard += 1;
    const old = oldTools(state).filter(name => !state.required.has(name));
    const oldStale = old.filter(name => !state.turnCalled.has(name));
    const newStale = [...state.selected].filter(name => !state.required.has(name) && state.turnLoaded.has(name) && !state.turnCalled.has(name));
    const pool = oldStale.length > 0
      ? oldStale
      : old.length > 0
        ? old
        : newStale.length > 0
          ? newStale
          : [...state.selected].filter(name => !state.required.has(name));
    if (pool.length === 0) break;
    const victim = sortByOldest(state, pool)[0];
    const detail = state.lastCalled.get(victim);
    const removed = unloadNames(state, [victim], 'inactivity', false);
    if (removed.length > 0) {
      removed[0].lastCalledTurn = detail?.turn ?? -1;
      removed[0].lastCalledStep = detail?.step ?? -1;
      autoUnloaded.push(removed[0]);
    }
  }
  return autoUnloaded;
}

function markCalled(state, name, turn, step) {
  if (!state.selected.has(name)) return;
  state.turnCalled.add(name);
  state.callSeq += 1;
  state.lastCalled.set(name, { turn, step, seq: state.callSeq });
  if (state.selected.size > 0 && [...state.selected].every(n => state.turnCalled.has(n))) {
    state.exceptionLatched = true;
  }
}

function admittedOf(ctx, state, exec) {
  if (exec === undefined || exec.toolSet === undefined) return null;
  try {
    return new Set(ctx.tools.schemas(state.agent, exec.toolSet).map(tool => tool.name));
  } catch {
    return null;
  }
}

function activationSkillOf(config, state, name) {
  return config.activationSkillByTool[name] ?? state.knownGated.get(name) ?? null;
}

function reconcile(state, ctx, config, exec) {
  const admitted = admittedOf(ctx, state, exec);
  state.admissionChecked = admitted !== null;
  if (admitted === null) return [];
  const removed = [];
  for (const name of [...state.selected]) {
    if (admitted.has(name)) continue;
    if (state.pendingAdmission.get(name) === state.step) continue;
    const skill = activationSkillOf(config, state, name);
    state.knownGated.set(name, skill);
    removed.push(...unloadNames(state, [name], 'gated'));
  }
  for (const item of removed) state.counters.evicted += 1;
  return removed;
}

function renderIndex(state) {
  const names = state.catalog.map(tool => tool.name).sort();
  if (names.length === 0) return '';
  const gated = names.filter(name => state.knownGated.has(name));
  const groups = new Map();
  for (const name of names) {
    const group = groupOf(name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  }
  const order = [...GROUPS.map(([group]) => group), 'singleton'];
  const lines = [];
  lines.push('TOOL INDEX: ' + names.length + ' registered; ' + gated.length + ' gated (need a skill).');
  for (const group of order) {
    const list = groups.get(group);
    if (list === undefined || list.length === 0) continue;
    lines.push(group + '(' + list.length + '): ' + list.join(' '));
  }
  if (gated.length > 0) {
    const parts = gated.map(name => {
      const skill = state.knownGated.get(name);
      return skill === null || skill === undefined ? name : name + '[' + skill + ']';
    });
    lines.push('Gated (activate its skill before loading): ' + parts.join(' '));
  }
  lines.push('Discovery policy: the index above names every tool.');
  lines.push('- If a skill applies, load it first: skills name the exact tools and the activation they require.');
  lines.push('- Use tool_search only for a name you do not know or a description you need; it loads nothing.');
  lines.push('- Load only what the task needs, never the whole match set.');
  return lines.join('\n');
}

function str() { return { type: 'string' }; }
function int() { return { type: 'integer' }; }
function bool() { return { type: 'boolean' }; }
function strArray() { return { type: 'array', items: { type: 'string' } }; }
function evictedSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: str(),
      lastCalledTurn: int(),
      lastCalledStep: int(),
      reason: str(),
      message: str(),
    },
    required: ['name', 'lastCalledTurn', 'lastCalledStep', 'reason', 'message'],
  };
}

function buildToolSearch(state, config) {
  return {
    name: 'tool_search',
    description: 'Return keyword-matched tools that are NOT loaded yet, with their descriptions. Read-only: it never loads, never counts against capacity, and does not list loaded tools. Query with a name to read one tool description; query with capability words to discover. The tool index is always present in the SDK.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: config.maxQueryChars, description: 'Required keyword or exact tool name.' },
        limit: { type: 'integer', minimum: 1, maximum: config.exceptionMax, description: 'Deprecated; accepted and ignored. Search returns every match.' },
        namesOnly: { type: 'boolean', description: 'Deprecated; accepted and ignored.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: str(),
          matched: int(),
          skippedLoaded: int(),
          gatedCount: int(),
          unloadedGated: strArray(),
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: str(),
                group: str(),
                description: str(),
                gated: bool(),
                activationSkill: str(),
              },
              required: ['name', 'group', 'description', 'gated'],
            },
          },
          admissionChecked: bool(),
          controlPlane: bool(),
          instruction: str(),
          deprecated: strArray(),
        },
        required: ['query', 'matched', 'skippedLoaded', 'gatedCount', 'unloadedGated', 'tools', 'admissionChecked', 'controlPlane', 'instruction', 'deprecated'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Search requires its owning live agent');
      exec.signal.throwIfAborted();
      const unloadedGated = reconcile(state, state.ctx, config, exec).map(item => item.name);
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (query.length === 0) throw new Error('query is required: the tool index is already in the SDK; pass a keyword or an exact tool name');
      if (query.length > config.maxQueryChars) throw new Error('query is too long');
      const deprecated = [];
      if (args.limit !== undefined) deprecated.push('limit');
      if (args.namesOnly !== undefined) deprecated.push('namesOnly');
      const matches = rankTools(state.catalog, query, state.catalog.length).map(tool => tool.name);
      const unloaded = matches.filter(name => !state.selected.has(name) && !state.permanent.has(name));
      const rows = unloaded.map(name => {
        const tool = state.catalog.find(entry => entry.name === name);
        const full = tool?.description ?? '';
        const description = config.searchDescriptionChars > 0 ? full.slice(0, config.searchDescriptionChars) : full;
        const row = { name, group: groupOf(name), description, gated: state.knownGated.has(name) };
        const skill = activationSkillOf(config, state, name);
        if (skill !== null) row.activationSkill = skill;
        return row;
      });
      state.counters.searched += 1;
      return {
        query,
        matched: rows.length,
        skippedLoaded: matches.length - unloaded.length,
        gatedCount: rows.filter(row => row.gated).length,
        unloadedGated,
        tools: rows,
        admissionChecked: state.admissionChecked,
        controlPlane: true,
        instruction: 'Control-plane call. End this step after reading the result; nothing was loaded.',
        deprecated,
      };
    },
  };
}

function buildToolLoad(state, config) {
  return {
    name: 'tool_load',
    description: 'Load tools by exact name (idempotent). Batch limited per call; over-capacity loads evict the oldest inactive tool. Gated tools are refused with the activation skill to run first. Use pin: true to keep a tool through inactivity eviction.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Exact tool names, as a string or an array of strings.',
        },
        pin: { type: 'boolean', description: 'Pin loaded tools against inactivity eviction.' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: strArray(),
          alreadyLoaded: strArray(),
          refused: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: str(),
                reason: str(),
                activationSkill: str(),
              },
              required: ['name', 'reason'],
            },
          },
          unknown: strArray(),
          evicted: { type: 'array', items: evictedSchema() },
          headroom: int(),
          capacity: int(),
          nextRequest: bool(),
          controlPlane: bool(),
          admissionChecked: bool(),
          instruction: str(),
        },
        required: ['loaded', 'alreadyLoaded', 'refused', 'unknown', 'evicted', 'headroom', 'capacity', 'nextRequest', 'controlPlane', 'admissionChecked', 'instruction'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Load requires its owning live agent');
      exec.signal.throwIfAborted();
      const reconciled = reconcile(state, state.ctx, config, exec);
      const evicted = [...reconciled];
      const raw = Array.isArray(args?.names)
        ? args.names
        : typeof args?.names === 'string'
          ? args.names.split(/[,;\s]+/)
          : [];
      const wanted = [...new Set(raw.map(name => String(name).trim()).filter(Boolean))];
      if (wanted.length === 0) throw new Error('names is required: pass exact tool names');
      const loaded = [];
      const alreadyLoaded = [];
      const refused = [];
      const unknown = [];
      const accepted = [];
      for (const name of wanted) {
        const tool = state.catalog.find(entry => entry.name.toLowerCase() === name.toLowerCase());
        if (tool === undefined) {
          unknown.push(name);
          continue;
        }
        const canonical = tool.name;
        if (state.selected.has(canonical) || state.permanent.has(canonical)) {
          alreadyLoaded.push(canonical);
          if (args?.pin === true) state.required.add(canonical);
          continue;
        }
        if (state.knownGated.has(canonical)) {
          const reason = { name: canonical, reason: 'gated' };
          const skill = activationSkillOf(config, state, canonical);
          if (skill !== null) reason.activationSkill = skill;
          refused.push(reason);
          continue;
        }
        accepted.push(canonical);
      }
      const batch = accepted.slice(0, config.loadBatchMax);
      for (const name of accepted.slice(config.loadBatchMax)) refused.push({ name, reason: 'batch-limit' });
      if (batch.length > 0) {
        evicted.push(...ensureRoom(state, batch.length, config));
        const room = headroomOf(state, config);
        const toLoad = batch.slice(0, Math.max(0, room));
        for (const name of batch.slice(toLoad.length)) refused.push({ name, reason: 'capacity' });
        for (const name of toLoad) {
          state.selected.add(name);
          state.turnLoaded.add(name);
          state.pendingAdmission.set(name, state.step);
          if (args?.pin === true) state.required.add(name);
          loaded.push(name);
        }
        if (toLoad.length > 0) applyRestriction(state);
      }
      for (const item of evicted.slice(reconciled.length)) state.counters.evicted += 1;
      state.counters.loadCalls += 1;
      state.counters.refused += refused.length + unknown.length;
      return {
        loaded,
        alreadyLoaded,
        refused,
        unknown,
        evicted,
        headroom: headroomOf(state, config),
        capacity: nowCapacity(state, config),
        nextRequest: true,
        controlPlane: true,
        admissionChecked: state.admissionChecked,
        instruction: 'Control-plane call. End this step after reading the result; the next model request carries the new SDK.',
      };
    },
  };
}

function buildToolUnload(state, config) {
  return {
    name: 'tool_unload',
    description: 'Unload named mutable schemas or all mutable schemas; permanent tools cannot be unloaded. This is a control-plane call: call it alone, read the result, end the step, and use the new SDK on the NEXT model request.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Tool names to unload. Omit to unload every loaded schema.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          unloaded: { type: 'array', items: evictedSchema() },
          loaded: strArray(),
          selected: strArray(),
          permanent: strArray(),
          headroom: int(),
          capacity: int(),
          autoUnloadMax: int(),
          exceptionLatched: bool(),
          nextRequest: bool(),
          controlPlane: bool(),
          instruction: str(),
        },
        required: ['unloaded', 'loaded', 'selected', 'permanent', 'headroom', 'capacity', 'autoUnloadMax', 'exceptionLatched', 'nextRequest', 'controlPlane', 'instruction'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Unload requires its owning live agent');
      exec.signal.throwIfAborted();
      const names = Array.isArray(args?.names) && args.names.length > 0 ? args.names : [...state.selected];
      const unloaded = [];
      for (const name of names) {
        const detail = state.lastCalled.get(name);
        const removed = unloadNames(state, [name], 'manual');
        if (removed.length > 0) {
          removed[0].lastCalledTurn = detail?.turn ?? -1;
          removed[0].lastCalledStep = detail?.step ?? -1;
          unloaded.push(removed[0]);
        }
      }
      return {
        unloaded,
        loaded: [...state.permanent, ...state.selected].sort(),
        selected: [...state.selected].sort(),
        permanent: [...state.permanent].sort(),
        headroom: headroomOf(state, config),
        capacity: nowCapacity(state, config),
        autoUnloadMax: autoUnloadMaxOf(state),
        exceptionLatched: state.exceptionLatched,
        nextRequest: true,
        controlPlane: true,
        instruction: 'Control-plane call. End this step after reading the result; the next model request carries the new SDK.',
      };
    },
  };
}

function buildToolRequire(state, config) {
  return {
    name: 'tool_require',
    description: 'Compatibility alias: pin loaded tools so inactivity eviction never selects them. Prefer tool_load({ pin: true }). This is a control-plane call: call it alone, read the result, end the step, and start using the next SDK on the NEXT model request.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Tool names to pin. Omit or empty with clear=true to clear all pins.' },
        clear: { type: 'boolean', description: 'Clear all pins before applying names.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          required: strArray(),
          selected: strArray(),
          permanent: strArray(),
          nextRequest: bool(),
          controlPlane: bool(),
          instruction: str(),
        },
        required: ['required', 'selected', 'permanent', 'nextRequest', 'controlPlane', 'instruction'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Require requires its owning live agent');
      exec.signal.throwIfAborted();
      if (args?.clear === true) {
        state.required.clear();
        state.requiredBySkill.clear();
      }
      const names = Array.isArray(args?.names) ? args.names : [];
      for (const name of names) {
        if (typeof name !== 'string') throw new Error('names must be strings');
        if (state.catalog.some(tool => tool.name === name)) state.required.add(name);
      }
      return {
        required: [...state.required].sort(),
        selected: [...state.selected].sort(),
        permanent: [...state.permanent].sort(),
        nextRequest: true,
        controlPlane: true,
        instruction: 'Control-plane call. End this step after reading the result; the next model request carries the new SDK.',
      };
    },
  };
}

function buildToolInventory(state, config) {
  return {
    name: 'tool_inventory',
    description: 'Return the current tool-loading inventory for this PTC session: selected, permanent, known gated tools, capacity, headroom, latch state, counters, and evictions observed this turn. Read-only.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selected: strArray(),
          loaded: strArray(),
          permanent: strArray(),
          availableCount: int(),
          availableGroups: { type: 'object', additionalProperties: true },
          controlViolation: str(),
          evicted: strArray(),
          required: strArray(),
          memoryRead: str(),
          capacity: int(),
          headroom: int(),
          autoUnloadMax: int(),
          exceptionLatched: bool(),
          gated: strArray(),
          gatedSkills: { type: 'object', additionalProperties: true },
          admissionChecked: bool(),
          searched: int(),
          loadCalls: int(),
          refusedTotal: int(),
          evictedTotal: int(),
        },
        required: ['selected', 'loaded', 'permanent', 'availableCount', 'availableGroups', 'controlViolation', 'evicted', 'required', 'memoryRead', 'capacity', 'headroom', 'autoUnloadMax', 'exceptionLatched', 'gated', 'gatedSkills', 'admissionChecked', 'searched', 'loadCalls', 'refusedTotal', 'evictedTotal'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (exec.agent !== state.agent) throw new Error('Inventory requires its owning live agent');
      exec.signal.throwIfAborted();
      const availableGroups = {};
      let availableCount = 0;
      for (const tool of state.catalog) {
        if (state.selected.has(tool.name) || state.permanent.has(tool.name)) continue;
        const group = groupOf(tool.name);
        availableGroups[group] = (availableGroups[group] ?? 0) + 1;
        availableCount += 1;
      }
      const gated = [...state.knownGated.keys()].sort();
      const gatedSkills = {};
      for (const name of gated) gatedSkills[name] = activationSkillOf(config, state, name);
      return {
        selected: [...state.selected].sort(),
        loaded: [...state.permanent, ...state.selected].sort(),
        permanent: [...state.permanent].sort(),
        availableCount,
        availableGroups,
        controlViolation: state.controlViolation,
        evicted: state.autoUnloadedThisTurn.map(item => item.name),
        required: [...state.required].sort(),
        memoryRead: state.catalog.some(item => item.name === 'memory_read') ? 'available' : 'unavailable',
        capacity: nowCapacity(state, config),
        headroom: headroomOf(state, config),
        autoUnloadMax: autoUnloadMaxOf(state),
        exceptionLatched: state.exceptionLatched,
        gated,
        gatedSkills,
        admissionChecked: state.admissionChecked,
        searched: state.counters.searched,
        loadCalls: state.counters.loadCalls,
        refusedTotal: state.counters.refused,
        evictedTotal: state.counters.evicted,
      };
    },
  };
}

function isPtcAgent(ctx, agent, schemas) {
  if (schemas.some(tool => tool.name === 'run_code')) return true;
  if (agent?.session?.header?.agentPreset === 'ptc') return true;
  try {
    const executor = ctx.tools.selectExecutor?.(agent);
    if (executor === undefined || typeof executor.describe !== 'function') return false;
    const described = executor.describe(schemas);
    return Array.isArray(described?.schemas)
      && described.schemas.some(schema => schema?.name === 'run_code');
  } catch {
    return false;
  }
}

export function apply(ctx, options = {}) {
  const config = {
    enabled: true,
    maxLoaded: BASE_CAPACITY,
    exceptionMax: DEFAULT_EXCEPTION,
    maxQueryChars: 256,
    maxDescriptionChars: 160,
    searchDescriptionChars: DEFAULT_SEARCH_DESCRIPTION_CHARS,
    loadBatchMax: DEFAULT_LOAD_BATCH,
    permanentTools: DEFAULT_PERMANENT,
    maxPermanent: 6,
    requiredToolsBySkill: {},
    activationSkillByTool: DEFAULT_ACTIVATION_SKILLS,
    gatedTools: {},
    ...options,
  };
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean');
  for (const field of ['maxLoaded', 'exceptionMax', 'maxQueryChars', 'maxDescriptionChars', 'maxPermanent', 'loadBatchMax']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(field + ' must be a positive integer');
  }
  if (!Number.isSafeInteger(config.searchDescriptionChars) || config.searchDescriptionChars < 0) throw new Error('searchDescriptionChars must be a non-negative integer');
  if (config.exceptionMax < config.maxLoaded) throw new Error('exceptionMax must be >= maxLoaded');
  if (!Array.isArray(config.permanentTools) || config.permanentTools.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('permanentTools must be an array of non-empty tool names');
  }
  if (config.permanentTools.length > config.maxPermanent) throw new Error('permanentTools exceeds maxPermanent');
  for (const field of ['requiredToolsBySkill', 'activationSkillByTool', 'gatedTools']) {
    const value = config[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' must be an object');
  }
  for (const [skill, tools] of Object.entries(config.requiredToolsBySkill)) {
    if (typeof skill !== 'string' || skill.length === 0) throw new Error('requiredToolsBySkill keys must be non-empty skill names');
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
      throw new Error('requiredToolsBySkill values must be arrays of non-empty tool names');
    }
  }
  for (const [tool, skill] of Object.entries(config.activationSkillByTool)) {
    if (typeof tool !== 'string' || tool.length === 0) throw new Error('activationSkillByTool keys must be non-empty tool names');
    if (typeof skill !== 'string' || skill.length === 0) throw new Error('activationSkillByTool values must be non-empty skill names');
  }
  for (const [tool, skill] of Object.entries(config.gatedTools)) {
    if (typeof tool !== 'string' || tool.length === 0) throw new Error('gatedTools keys must be non-empty tool names');
    if (typeof skill !== 'string' || skill.length === 0) throw new Error('gatedTools values must be non-empty skill names');
  }
  if (!config.enabled) return;
  const owners = new Map();
  const sessionOwners = new Map();

  let sectionOrder;
  try {
    const base = ctx.systemPrompt.getSectionOrder('TOOLS_SDK');
    sectionOrder = Number.isFinite(base) ? base - 1 : undefined;
  } catch {
    sectionOrder = undefined;
  }
  if (typeof ctx.systemPrompt?.section === 'function') {
    try {
      const definition = {
        name: 'tools:index',
        text: (view = {}) => {
          const state = sessionOwners.get(sessionIdOf(view.scope));
          if (state === undefined) return '';
          return renderIndex(state);
        },
      };
      if (typeof sectionOrder === 'number') definition.order = sectionOrder;
      const dispose = ctx.systemPrompt.section(definition);
      if (typeof dispose === 'function') ctx.effect(() => dispose);
    } catch {
      /* the index section is optional; search and load still work without it */
    }
  }

  function onSessionEvent(session, event) {
    const id = sessionIdOf(session);
    const state = sessionOwners.get(id);
    if (state === undefined) return;
    if (event.type === 'turn/start') {
      state.turn = event.data?.turn ?? state.turn + 1;
      state.step = 0;
      state.turnCalled.clear();
      state.turnLoaded.clear();
      state.exceptionLatched = false;
      state.autoUnloadedThisTurn = [];
      state.controlInStep = false;
      state.businessInStep = false;
      state.controlViolation = '';
      return;
    }
    if (event.type === 'step/start') {
      state.step = event.data?.step ?? state.step;
      state.pendingAdmission.clear();
      state.controlInStep = false;
      state.businessInStep = false;
      return;
    }
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return;
    const name = event.data?.name;
    if (typeof name !== 'string' || name.length === 0) return;
    if (CONTROL_TOOLS.has(name)) {
      state.controlInStep = true;
      if (state.businessInStep) state.controlViolation = 'control-plane ' + name + ' was mixed with another tool in the same step';
    } else if (name !== 'run_code' && name !== 'tool_inventory') {
      state.businessInStep = true;
      if (state.controlInStep) state.controlViolation = 'control-plane call was mixed with ' + name + ' in the same step';
    }
    if (name === 'skill' && event.type === 'tool/ptc-dispatch' && event.data?.isError !== true) {
      const skill = skillNameFromArguments(event.data?.arguments);
      if (skill !== '') {
        for (const [toolName, requiredSkill] of [...state.knownGated.entries()]) {
          if (requiredSkill === skill) state.knownGated.delete(toolName);
        }
        const required = config.requiredToolsBySkill[skill];
        if (Array.isArray(required)) {
          const pinned = new Set(required.filter(tool => state.catalog.some(entry => entry.name === tool)));
          state.requiredBySkill.set(skill, pinned);
          let changed = false;
          for (const tool of pinned) {
            state.required.add(tool);
            if (!state.selected.has(tool) && !state.permanent.has(tool) && !state.knownGated.has(tool) && headroomOf(state, config) > 0) {
              state.selected.add(tool);
              state.turnLoaded.add(tool);
              changed = true;
            }
          }
          if (changed) applyRestriction(state);
        }
      }
    }
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : state.turn;
    const step = typeof event.data?.step === 'number' ? event.data.step : state.step;
    markCalled(state, name, turn, step);
  }

  const disposeSession = ctx.on('session/event', onSessionEvent);
  ctx.effect(() => () => {
    if (typeof disposeSession === 'function') disposeSession();
  }, 'ptc-tool-search: session tracking');

  ctx.on('agent/created', ({ agent }) => {
    const schemas = ctx.tools.schemas(agent);
    if (!isPtcAgent(ctx, agent, schemas)) return;
    if (schemas.some(tool => tool.name === 'tool_search')) throw new Error('A tool_search tool already exists; enable only one discovery plugin');
    const catalog = schemas.filter(tool => tool.name !== 'run_code')
      .map(tool => ({ name: tool.name, description: tool.description ?? '' }));
    const permanent = new Set(config.permanentTools.filter(name => catalog.some(tool => tool.name === name)));
    const state = {
      agent,
      ctx,
      catalog,
      permanent,
      selected: new Set(),
      lastCalled: new Map(),
      turnCalled: new Set(),
      turn: 0,
      step: 0,
      callSeq: 0,
      exceptionLatched: false,
      autoUnloadedThisTurn: [],
      turnLoaded: new Set(),
      required: new Set(),
      requiredBySkill: new Map(),
      controlInStep: false,
      businessInStep: false,
      controlViolation: '',
      restriction: null,
      sessionId: sessionIdOf(agent.session),
      knownGated: new Map(),
      pendingAdmission: new Map(),
      admissionChecked: false,
      counters: { searched: 0, loadCalls: 0, refused: 0, evicted: 0 },
    };
    for (const [tool, skill] of Object.entries(config.gatedTools)) {
      if (catalog.some(entry => entry.name === tool)) state.knownGated.set(tool, skill);
    }
    const dispose = agent.ctx.effect(() => {
      state.restriction = agent.ctx.tools.restrict({ allow: [...state.permanent] });
      const search = buildToolSearch(state, config);
      const load = buildToolLoad(state, config);
      const unload = buildToolUnload(state, config);
      const inventory = buildToolInventory(state, config);
      const requireTool = buildToolRequire(state, config);
      const unregisterSearch = agent.ctx.tools.register(search);
      const unregisterLoad = agent.ctx.tools.register(load);
      const unregisterUnload = agent.ctx.tools.register(unload);
      const unregisterInventory = agent.ctx.tools.register(inventory);
      const unregisterRequire = agent.ctx.tools.register(requireTool);
      if (state.sessionId) sessionOwners.set(state.sessionId, state);
      return () => {
        if (state.sessionId) sessionOwners.delete(state.sessionId);
        unregisterSearch();
        unregisterLoad();
        unregisterUnload();
        unregisterInventory();
        unregisterRequire();
        state.restriction();
      };
    });
    owners.set(agent, dispose);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    owners.get(agent)?.();
    owners.delete(agent);
  });
  ctx.effect(() => () => {
    for (const dispose of owners.values()) dispose();
    owners.clear();
    sessionOwners.clear();
  });
}
