import { rankTools } from './search.js';

export const name = '@hrygo/dsh-ptc-tool-search';
export const inject = ['tools', 'agents'];

const BASE_CAPACITY = 16;
const DEFAULT_EXCEPTION = 24;
const DEFAULT_PERMANENT = ['pwsh', 'read', 'write', 'edit', 'memory_read'];
const TOOL_FACTS = [
  'TOOL DISCOVERY CONTRACT:',
  '1. The tool index is always complete; never treat a truncated result as all callable tools.',
  '2. Default loaded-schema capacity is 16.',
  '3. When every currently loaded tool has been called in this turn, the turn exception latches and capacity becomes 24.',
  '4. autoUnloadMax=0 means headroom is computed against 24; otherwise headroom is computed against 16.',
  '5. Single-turn loading is limited only by headroom, not by a fixed result count.',
  '6. When capacity is full, the tool with the oldest last call is auto-unloaded; the result lists autoUnloaded with reason inactivity.',
  '7. tool_search returns catalogComplete, totalTools, returned, loaded, headroom, capacity, autoUnloadMax, autoUnloaded, exceptionLatched.',
  '8. tool_unload removes named tools or all tools.',
  '9. A small configured set of high-frequency permanent tools is always declared and does not consume the 16/24 mutable capacity.',
  '10. tool_search, tool_unload and tool_require are control-plane calls: call them alone in a step, read the result, end the step, and use the new SDK on the next model request.',
].join(' ');

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

function sessionIdOf(session) {
  return session?.header?.id ?? session?.id ?? '';
}

function skillNameFromArguments(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  return typeof args?.name === 'string' ? args.name : '';
}

function nowCapacity(state, config) {
  if (state.exceptionLatched) return config.exceptionMax;
  return config.maxLoaded;
}

function oldTools(state) {
  return [...state.selected].filter(name => !state.turnLoaded.has(name));
}

function oldStaleTools(state) {
  return oldTools(state).filter(name => !state.turnCalled.has(name));
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
  state.restriction();
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
        ? '该工具因长时间未被调用已被自动卸载'
        : '该工具已被显式卸载',
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

function indexRow(state, tool, config) {
  return {
    name: tool.name,
    group: groupOf(tool.name),
    description: tool.description.slice(0, config.maxDescriptionChars),
    loaded: state.selected.has(tool.name) || state.permanent.has(tool.name),
    permanent: state.permanent.has(tool.name),
    calledThisTurn: state.turnCalled.has(tool.name),
  };
}

function availableGroupsOf(state) {
  const groups = {};
  for (const tool of state.catalog) {
    if (state.selected.has(tool.name) || state.permanent.has(tool.name)) continue;
    const group = groupOf(tool.name);
    groups[group] = (groups[group] ?? 0) + 1;
  }
  return groups;
}

function availableCountOf(state) {
  return state.catalog.filter(tool => !state.selected.has(tool.name) && !state.permanent.has(tool.name)).length;
}

function stateView(state, config, extra) {
  const autoUnloadMax = autoUnloadMaxOf(state);
  const capacity = nowCapacity(state, config);
  const headroom = Math.max(0, capacity - state.selected.size);
  return {
    catalogComplete: true,
    totalTools: state.catalog.length,
    returned: state.catalog.length,
    loaded: [...state.permanent, ...state.selected].sort(),
    selected: [...state.selected].sort(),
    permanent: [...state.permanent].sort(),
    availableCount: availableCountOf(state),
    availableGroups: availableGroupsOf(state),
    controlViolation: state.controlViolation,
    headroom,
    capacity,
    autoUnloadMax,
    exceptionLatched: state.exceptionLatched,
    autoUnloadedThisTurn: state.autoUnloadedThisTurn,
    nextRequest: true,
    ...extra,
  };
}

function buildToolRequire(state, config) {
  return {
    name: 'tool_require',
    description: 'Pin mutable tools that must survive automatic unloading for the current task. Pinned tools are never selected as inactivity victims; explicit tool_unload still removes them. This is a control-plane call: call it alone, read the result, end the step, and start using the next SDK on the NEXT model request.',
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
        properties: {
          required: { type: 'array', items: { type: 'string' } },
          selected: { type: 'array', items: { type: 'string' } },
          permanent: { type: 'array', items: { type: 'string' } },
          nextRequest: { type: 'boolean' },
          controlPlane: { type: 'boolean' },
          instruction: { type: 'string' },
        },
        required: ['required', 'selected', 'permanent', 'nextRequest', 'controlPlane', 'instruction'],
        additionalProperties: false,
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

function buildToolSearch(state, config) {
  return {
    name: 'tool_search',
    description: TOOL_FACTS + ' Call with await tools.tool_search({query:"bash"}) inside run_code. This is a control-plane call: do not mix it with other tools or use newly loaded tools in the same step; print/read the result, end the step, and use the new SDK on the NEXT model request. Empty query returns the complete index; namesOnly returns names/groups without descriptions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: config.maxQueryChars, description: 'Empty or omitted returns the complete index without loading. Otherwise rank names/descriptions and load matching tools up to headroom.' },
        limit: { type: 'integer', minimum: 1, maximum: config.exceptionMax, description: 'Optional maximum schemas to load this call. Omit to load all matching schemas up to headroom.' },
        namesOnly: { type: 'boolean', description: 'Return names/groups without descriptions and without loading anything. Useful for a compact available-tool list.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string' },
          catalogComplete: { type: 'boolean' },
          totalTools: { type: 'integer' },
          returned: { type: 'integer' },
          tools: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' },
            group: { type: 'string' },
            description: { type: 'string' },
            loaded: { type: 'boolean' },
            permanent: { type: 'boolean' },
            calledThisTurn: { type: 'boolean' },
          }, required: ['name', 'group', 'description', 'loaded', 'permanent', 'calledThisTurn'], additionalProperties: false } },
          matches: { type: 'array', items: { type: 'string' } },
          loaded: { type: 'array', items: { type: 'string' } },
          selected: { type: 'array', items: { type: 'string' } },
          permanent: { type: 'array', items: { type: 'string' } },
          availableCount: { type: 'integer' },
          availableGroups: { type: 'object', additionalProperties: true, description: 'Available tool count keyed by group; the group key set is open.' },
          controlViolation: { type: 'string' },
          notLoaded: { type: 'array', items: { type: 'string' } },
          autoUnloaded: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' },
            lastCalledTurn: { type: 'integer' },
            lastCalledStep: { type: 'integer' },
            reason: { type: 'string' },
            message: { type: 'string' },
          }, required: ['name', 'lastCalledTurn', 'lastCalledStep', 'reason', 'message'], additionalProperties: false } },
          headroom: { type: 'integer' },
          capacity: { type: 'integer' },
          autoUnloadMax: { type: 'integer' },
          exceptionLatched: { type: 'boolean' },
          autoUnloadedThisTurn: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' },
            lastCalledTurn: { type: 'integer' },
            lastCalledStep: { type: 'integer' },
            reason: { type: 'string' },
            message: { type: 'string' },
          }, required: ['name', 'lastCalledTurn', 'lastCalledStep', 'reason', 'message'], additionalProperties: false } },
          nextRequest: { type: 'boolean' },
          controlPlane: { type: 'boolean' },
          instruction: { type: 'string' },
        },
        required: ['query', 'mode', 'catalogComplete', 'totalTools', 'returned', 'tools', 'matches', 'loaded', 'selected', 'permanent', 'availableCount', 'availableGroups', 'controlViolation', 'notLoaded', 'autoUnloaded', 'headroom', 'capacity', 'autoUnloadMax', 'exceptionLatched', 'autoUnloadedThisTurn', 'nextRequest', 'controlPlane', 'instruction'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Search requires its owning live agent');
      exec.signal.throwIfAborted();
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      const namesOnly = args?.namesOnly === true;
      if (query.length > config.maxQueryChars) throw new Error('query is too long');
      const capacity = nowCapacity(state, config);
      const matches = query === ''
        ? []
        : rankTools(state.catalog, query, state.catalog.length).map(tool => tool.name);
      const newMatches = matches.filter(name => !state.selected.has(name) && !state.permanent.has(name));
      const requested = namesOnly || newMatches.length === 0
        ? 0
        : Math.min(newMatches.length, args?.limit ?? capacity);
      if (requested > 0) {
        const autoUnloaded = ensureRoom(state, requested, config);
        state.autoUnloadedThisTurn.push(...autoUnloaded);
      }
      const room = headroomOf(state, config);
      const loadCount = Math.min(requested, room);
      const toLoad = newMatches.slice(0, loadCount);
      for (const name of toLoad) {
        if (state.catalog.some(tool => tool.name === name)) {
          state.selected.add(name);
          state.turnLoaded.add(name);
        }
      }
      if (toLoad.length > 0) applyRestriction(state);
      const availableNames = state.catalog
        .filter(tool => !state.selected.has(tool.name) && !state.permanent.has(tool.name))
        .map(tool => tool.name);
      const notLoaded = namesOnly ? availableNames : newMatches.slice(loadCount);
      const extra = {
        query,
        mode: namesOnly ? 'names' : query === '' ? 'index' : 'search',
        tools: state.catalog.map(tool => {
          const row = indexRow(state, tool, config);
          return namesOnly ? { ...row, description: '' } : row;
        }),
        matches,
        notLoaded,
        autoUnloaded: state.autoUnloadedThisTurn.slice(),
        controlPlane: true,
        instruction: 'Control-plane call. End this step after reading the result; the next model request carries the new SDK.',
      };
      return stateView(state, config, extra);
    },
  };
}

function buildToolUnload(state, config) {
  return {
    name: 'tool_unload',
    description: TOOL_FACTS + ' Unload named mutable schemas or all mutable schemas; permanent tools cannot be unloaded. This is a control-plane call: call it alone, read the result, end the step, and use the new SDK on the NEXT model request.',
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
        properties: {
          unloaded: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' },
            lastCalledTurn: { type: 'integer' },
            lastCalledStep: { type: 'integer' },
            reason: { type: 'string' },
            message: { type: 'string' },
          }, required: ['name', 'lastCalledTurn', 'lastCalledStep', 'reason', 'message'], additionalProperties: false } },
          loaded: { type: 'array', items: { type: 'string' } },
          selected: { type: 'array', items: { type: 'string' } },
          permanent: { type: 'array', items: { type: 'string' } },
          headroom: { type: 'integer' },
          capacity: { type: 'integer' },
          autoUnloadMax: { type: 'integer' },
          exceptionLatched: { type: 'boolean' },
          nextRequest: { type: 'boolean' },
          controlPlane: { type: 'boolean' },
          instruction: { type: 'string' },
        },
        required: ['unloaded', 'loaded', 'selected', 'permanent', 'headroom', 'capacity', 'autoUnloadMax', 'exceptionLatched', 'nextRequest', 'controlPlane', 'instruction'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Unload requires its owning live agent');
      exec.signal.throwIfAborted();
      const names = Array.isArray(args?.names) && args.names.length > 0
        ? args.names
        : [...state.selected];
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

function buildToolInventory(state, config) {
  return {
    name: 'tool_inventory',
    description: 'Return the current tool-loading inventory for this PTC session: mutable selected schemas, always-present permanent schemas, loaded union, available count/groups, capacity, headroom, latch state, and evictions observed this turn. Read-only; does not load or unload tools.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          selected: { type: 'array', items: { type: 'string' } },
          loaded: { type: 'array', items: { type: 'string' } },
          permanent: { type: 'array', items: { type: 'string' } },
          availableCount: { type: 'integer' },
          availableGroups: { type: 'object', additionalProperties: true, description: 'Available tool count keyed by group; the group key set is open.' },
          controlViolation: { type: 'string' },
          evicted: { type: 'array', items: { type: 'string' } },
          required: { type: 'array', items: { type: 'string' } },
          memoryRead: { type: 'string', enum: ['available', 'unavailable'] },
          capacity: { type: 'integer' },
          headroom: { type: 'integer' },
          autoUnloadMax: { type: 'integer' },
          exceptionLatched: { type: 'boolean' },
        },
        required: ['selected', 'loaded', 'permanent', 'availableCount', 'availableGroups', 'controlViolation', 'evicted', 'required', 'memoryRead', 'capacity', 'headroom', 'autoUnloadMax', 'exceptionLatched'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (exec.agent !== state.agent) throw new Error('Inventory requires its owning live agent');
      exec.signal.throwIfAborted();
      const evicted = state.autoUnloadedThisTurn.map(item => item.name);
      const memoryRead = state.catalog.some(item => item.name === 'memory_read') ? 'available' : 'unavailable';
      return {
        selected: [...state.selected].sort(),
        loaded: [...state.permanent, ...state.selected].sort(),
        permanent: [...state.permanent].sort(),
        availableCount: availableCountOf(state),
        availableGroups: availableGroupsOf(state),
        controlViolation: state.controlViolation,
        evicted,
        required: [...state.required].sort(),
        memoryRead,
        capacity: nowCapacity(state, config),
        headroom: headroomOf(state, config),
        autoUnloadMax: autoUnloadMaxOf(state),
        exceptionLatched: state.exceptionLatched,
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
    permanentTools: DEFAULT_PERMANENT,
    maxPermanent: 6,
    requiredToolsBySkill: {},
    ...options,
  };
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean');
  for (const field of ['maxLoaded', 'exceptionMax', 'maxQueryChars', 'maxDescriptionChars', 'maxPermanent']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(field + ' must be a positive integer');
  }
  if (config.exceptionMax < config.maxLoaded) throw new Error('exceptionMax must be >= maxLoaded');
  if (!Array.isArray(config.permanentTools) || config.permanentTools.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('permanentTools must be an array of non-empty tool names');
  }
  if (config.permanentTools.length > config.maxPermanent) throw new Error('permanentTools exceeds maxPermanent');
  if (config.requiredToolsBySkill === null || typeof config.requiredToolsBySkill !== 'object' || Array.isArray(config.requiredToolsBySkill)) {
    throw new Error('requiredToolsBySkill must be an object mapping skill names to tool-name arrays');
  }
  for (const [skill, tools] of Object.entries(config.requiredToolsBySkill)) {
    if (typeof skill !== 'string' || skill.length === 0) throw new Error('requiredToolsBySkill keys must be non-empty skill names');
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
      throw new Error('requiredToolsBySkill values must be arrays of non-empty tool names');
    }
  }
  if (!config.enabled) return;
  const owners = new Map();
  const sessionOwners = new Map();

  function onSessionEvent(session, event) {
    const id = sessionIdOf(session);
    const state = sessionOwners.get(id);
    if (!state) return;
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
      state.controlInStep = false;
      state.businessInStep = false;
      return;
    }
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return;
    const name = event.data?.name;
    if (typeof name !== 'string' || name.length === 0) return;
    const controls = new Set(['tool_search', 'tool_unload', 'tool_require']);
    if (controls.has(name)) {
      state.controlInStep = true;
      if (state.businessInStep) state.controlViolation = 'control-plane ' + name + ' was mixed with another tool in the same step';
    } else if (name !== 'run_code' && name !== 'tool_inventory') {
      state.businessInStep = true;
      if (state.controlInStep) state.controlViolation = 'control-plane call was mixed with ' + name + ' in the same step';
    }
    if (name === 'skill') {
      const skill = skillNameFromArguments(event.data?.arguments);
      const required = skill === '' ? undefined : config.requiredToolsBySkill[skill];
      if (Array.isArray(required)) {
        const pinned = new Set(required.filter(tool => state.catalog.some(entry => entry.name === tool)));
        state.requiredBySkill.set(skill, pinned);
        for (const tool of pinned) state.required.add(tool);
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
    };
    const dispose = agent.ctx.effect(() => {
      state.restriction = agent.ctx.tools.restrict({ allow: [...state.permanent] });
      const search = buildToolSearch(state, config);
      const unload = buildToolUnload(state, config);
      const inventory = buildToolInventory(state, config);
      const requireTool = buildToolRequire(state, config);
      const unregisterSearch = agent.ctx.tools.register(search);
      const unregisterUnload = agent.ctx.tools.register(unload);
      const unregisterInventory = agent.ctx.tools.register(inventory);
      const unregisterRequire = agent.ctx.tools.register(requireTool);
      if (state.sessionId) sessionOwners.set(state.sessionId, state);
      return () => {
        if (state.sessionId) sessionOwners.delete(state.sessionId);
        unregisterSearch();
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
