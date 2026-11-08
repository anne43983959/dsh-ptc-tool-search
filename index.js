import { rankTools } from './search.js';

export const name = '@hrygo/dsh-ptc-tool-search';
export const inject = ['tools', 'agents'];

const BASE_CAPACITY = 16;
const DEFAULT_EXCEPTION = 24;
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
  return Math.max(1, [...state.selected].filter(name => !state.turnCalled.has(name)).length);
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
  const replacement = state.agent.ctx.tools.restrict({ allow: [...state.selected] });
  state.restriction();
  state.restriction = replacement;
}

function unloadNames(state, names, reason) {
  const removed = [];
  for (const name of names) {
    if (!state.selected.has(name)) continue;
    state.selected.delete(name);
    state.lastCalled.delete(name);
    state.turnCalled.delete(name);
    state.turnLoaded.delete(name);
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
  if (state.selected.size === 0) state.exceptionLatched = false;
  applyRestriction(state);
  return removed;
}

function ensureRoom(state, wanted, config) {
  const autoUnloaded = [];
  let guard = 0;
  while (state.selected.size + wanted > nowCapacity(state, config) && guard < 100) {
    guard += 1;
    const old = oldTools(state);
    const oldStale = old.filter(name => !state.turnCalled.has(name));
    const newStale = [...state.selected].filter(name => state.turnLoaded.has(name) && !state.turnCalled.has(name));
    const pool = oldStale.length > 0
      ? oldStale
      : old.length > 0
        ? old
        : newStale.length > 0
          ? newStale
          : [...state.selected];
    if (pool.length === 0) break;
    const victim = sortByOldest(state, pool)[0];
    const detail = state.lastCalled.get(victim);
    const removed = unloadNames(state, [victim], 'inactivity');
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
    loaded: state.selected.has(tool.name),
    calledThisTurn: state.turnCalled.has(tool.name),
  };
}

function stateView(state, config, extra) {
  const autoUnloadMax = autoUnloadMaxOf(state);
  const capacity = nowCapacity(state, config);
  const headroom = Math.max(0, capacity - state.selected.size);
  return {
    catalogComplete: true,
    totalTools: state.catalog.length,
    returned: state.catalog.length,
    loaded: [...state.selected].sort(),
    selected: [...state.selected].sort(),
    headroom,
    capacity,
    autoUnloadMax,
    exceptionLatched: state.exceptionLatched,
    autoUnloadedThisTurn: state.autoUnloadedThisTurn,
    nextRequest: true,
    ...extra,
  };
}

function buildToolSearch(state, config) {
  return {
    name: 'tool_search',
    description: TOOL_FACTS + ' Call with await tools.tool_search({query:"bash"}) inside run_code. Print OR return the result once. Loaded tools enter the SDK on the NEXT model request; finish this run_code before calling them in another run_code. If the SDK no longer declares a previously used tool after resume, search again or call tool_unload.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: config.maxQueryChars, description: 'Empty or omitted returns the complete index without loading. Otherwise rank names/descriptions and load matching tools up to headroom.' },
        limit: { type: 'integer', minimum: 1, maximum: config.exceptionMax, description: 'Optional maximum schemas to load this call. Omit to load all matching schemas up to headroom.' },
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
            calledThisTurn: { type: 'boolean' },
          }, required: ['name', 'group', 'description', 'loaded', 'calledThisTurn'], additionalProperties: false } },
          matches: { type: 'array', items: { type: 'string' } },
          loaded: { type: 'array', items: { type: 'string' } },
          selected: { type: 'array', items: { type: 'string' } },
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
        },
        required: ['query', 'mode', 'catalogComplete', 'totalTools', 'returned', 'tools', 'matches', 'loaded', 'selected', 'notLoaded', 'autoUnloaded', 'headroom', 'capacity', 'autoUnloadMax', 'exceptionLatched', 'autoUnloadedThisTurn', 'nextRequest'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent !== state.agent) throw new Error('Search requires its owning live agent');
      exec.signal.throwIfAborted();
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (query.length > config.maxQueryChars) throw new Error('query is too long');
      const capacity = nowCapacity(state, config);
      const matches = query === ''
        ? []
        : rankTools(state.catalog, query, state.catalog.length).map(tool => tool.name);
      const newMatches = matches.filter(name => !state.selected.has(name));
      const requested = newMatches.length === 0
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
      const notLoaded = newMatches.slice(loadCount);
      const extra = {
        query,
        mode: query === '' ? 'index' : 'search',
        tools: state.catalog.map(tool => indexRow(state, tool, config)),
        matches,
        notLoaded,
        autoUnloaded: state.autoUnloadedThisTurn.slice(),
      };
      return stateView(state, config, extra);
    },
  };
}

function buildToolUnload(state, config) {
  return {
    name: 'tool_unload',
    description: TOOL_FACTS + ' Unload named schemas or all loaded schemas. The change applies to the next model request.',
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
          headroom: { type: 'integer' },
          capacity: { type: 'integer' },
          autoUnloadMax: { type: 'integer' },
          exceptionLatched: { type: 'boolean' },
          nextRequest: { type: 'boolean' },
        },
        required: ['unloaded', 'loaded', 'selected', 'headroom', 'capacity', 'autoUnloadMax', 'exceptionLatched', 'nextRequest'],
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
        loaded: [...state.selected].sort(),
        selected: [...state.selected].sort(),
        headroom: headroomOf(state, config),
        capacity: nowCapacity(state, config),
        autoUnloadMax: autoUnloadMaxOf(state),
        exceptionLatched: state.exceptionLatched,
        nextRequest: true,
      };
    },
  };
}

export function apply(ctx, options = {}) {
  const config = {
    enabled: true,
    maxLoaded: BASE_CAPACITY,
    exceptionMax: DEFAULT_EXCEPTION,
    maxQueryChars: 256,
    maxDescriptionChars: 160,
    ...options,
  };
  if (typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean');
  for (const field of ['maxLoaded', 'exceptionMax', 'maxQueryChars', 'maxDescriptionChars']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(field + ' must be a positive integer');
  }
  if (config.exceptionMax < config.maxLoaded) throw new Error('exceptionMax must be >= maxLoaded');
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
      return;
    }
    if (event.type === 'step/start') {
      state.step = event.data?.step ?? state.step;
      return;
    }
    if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') return;
    const name = event.data?.name;
    if (typeof name !== 'string' || name.length === 0) return;
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
    if (!schemas.some(tool => tool.name === 'run_code')) return;
    if (schemas.some(tool => tool.name === 'tool_search')) throw new Error('A tool_search tool already exists; enable only one discovery plugin');
    const catalog = schemas.filter(tool => tool.name !== 'run_code')
      .map(tool => ({ name: tool.name, description: tool.description ?? '' }));
    const state = {
      agent,
      catalog,
      selected: new Set(),
      lastCalled: new Map(),
      turnCalled: new Set(),
      turn: 0,
      step: 0,
      callSeq: 0,
      exceptionLatched: false,
      autoUnloadedThisTurn: [],
      turnLoaded: new Set(),
      restriction: null,
      sessionId: sessionIdOf(agent.session),
    };
    const dispose = agent.ctx.effect(() => {
      state.restriction = agent.ctx.tools.restrict({ allow: [] });
      const search = buildToolSearch(state, config);
      const unload = buildToolUnload(state, config);
      const unregisterSearch = agent.ctx.tools.register(search);
      const unregisterUnload = agent.ctx.tools.register(unload);
      if (state.sessionId) sessionOwners.set(state.sessionId, state);
      return () => {
        if (state.sessionId) sessionOwners.delete(state.sessionId);
        unregisterSearch();
        unregisterUnload();
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
