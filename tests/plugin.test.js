import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function fixture() {
  const handlers = new Map();
  const effects = [];
  const agents = new Map();
  const catalog = [
    { name: 'run_code', description: 'PTC transport' },
    { name: 'bash', description: 'Run terminal shell commands. ' + 'Detailed shell execution guidance. '.repeat(20) },
    { name: 'generate_image', description: 'Generate an image' },
  ];
  for (let i = 0; i < 30; i += 1) {
    catalog.push({ name: 'tool_' + String(i).padStart(2, '0'), description: 'Fixture tool ' + i });
  }
  const visible = agent => catalog.filter(t => t.name === 'run_code'
    || (agents.get(agent).masks.every(m => m.has(t.name)) && !agents.get(agent).denied.has(t.name)))
    .concat([...agents.get(agent).own.values()]);
  const ctx = {
    tools: { schemas: visible, get: (name, agent) => visible(agent).find(t => t.name === name) },
    on: (event, callback) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(callback);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter(x => x !== callback));
      };
    },
    effect: fn => { effects.push(fn()); },
  };
  function create({ ptc = true, denied = [], sessionId = 'sess-1' } = {}) {
    const agent = { session: { id: sessionId } };
    const state = { own: new Map(), masks: [], denied: new Set(denied) };
    agents.set(agent, state);
    agent.ctx = {
      effect: fn => fn(),
      tools: {
        restrict: ({ allow }) => {
          if (allow.includes('run_code')) throw new Error('reserved');
          const mask = new Set(allow);
          state.masks.push(mask);
          return () => { state.masks = state.masks.filter(x => x !== mask); };
        },
        register: def => { state.own.set(def.name, def); return () => state.own.delete(def.name); },
      },
    };
    if (!ptc) {
      const original = ctx.tools.schemas;
      ctx.tools.schemas = a => original(a).filter(t => t.name !== 'run_code');
      for (const handler of handlers.get('agent/created') ?? []) handler({ agent });
      ctx.tools.schemas = original;
    } else {
      for (const handler of handlers.get('agent/created') ?? []) handler({ agent });
    }
    return agent;
  }
  apply(ctx);
  function event(payload) {
    const session = { header: { id: payload.sessionId ?? 'sess-1' } };
    for (const handler of handlers.get('session/event') ?? []) handler(session, payload);
  }
  return {
    create, visible, agents, handlers, catalog, unload: () => effects.forEach(fn => fn()), event,
    search: (agent, args) => ctx.tools.get('tool_search', agent).execute(args, { agent, signal: new AbortController().signal }),
    unloadTool: (agent, args) => ctx.tools.get('tool_unload', agent).execute(args, { agent, signal: new AbortController().signal }),
  };
}

test('index is complete and empty query loads nothing', async () => {
  const f = fixture();
  const a = f.create();
  assert.deepEqual(f.visible(a).map(t => t.name).sort(), ['run_code', 'tool_search', 'tool_unload']);
  const out = await f.search(a, { query: '' });
  assert.equal(out.mode, 'index');
  assert.equal(out.catalogComplete, true);
  assert.equal(out.totalTools, 32);
  assert.equal(out.returned, 32);
  assert.equal(out.tools.length, 32);
  assert.equal(out.selected.length, 0);
  assert.equal(out.capacity, 16);
  assert.equal(out.headroom, 16);
  assert.equal(out.autoUnloadMax, 1);
});

test('loading uses headroom and becomes 24 after every loaded tool is called', async () => {
  const f = fixture();
  const a = f.create();
  const first = await f.search(a, { query: 'bash' });
  assert.deepEqual(first.selected, ['bash']);
  assert.equal(first.capacity, 16);
  assert.equal(first.headroom, 15);
  f.event({ type: 'turn/start', data: { turn: 1 } });
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'bash' } });
  const second = await f.search(a, { query: 'tool_', limit: 5 });
  assert.equal(second.exceptionLatched, true);
  assert.equal(second.capacity, 24);
  assert.equal(second.autoUnloadMax, 0);
  assert.equal(second.selected.length, 6);
  assert.equal(second.headroom, 18);
  for (const name of second.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  const third = await f.search(a, { query: 'tool_', limit: 18 });
  assert.equal(third.selected.length, 24);
  assert.equal(third.headroom, 0);
});

test('loading beyond 24 auto-unloads oldest old tool and returns warning', async () => {
  const f = fixture();
  const a = f.create();
  const first = await f.search(a, { query: 'tool_', limit: 16 });
  assert.equal(first.selected.length, 16);
  assert.equal(first.autoUnloadMax, 16);
  f.event({ type: 'turn/start', data: { turn: 1 } });
  for (const name of first.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  const second = await f.search(a, { query: 'tool_', limit: 8 });
  assert.equal(second.capacity, 24);
  assert.equal(second.selected.length, 24);
  for (const name of second.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  const third = await f.search(a, { query: 'tool_', limit: 1 });
  assert.equal(third.selected.length, 24);
  assert.equal(third.autoUnloaded.length, 1);
  assert.equal(third.autoUnloaded[0].reason, 'inactivity');
  assert.equal(Number.isInteger(third.autoUnloaded[0].lastCalledTurn), true);
  assert.equal(Number.isInteger(third.autoUnloaded[0].lastCalledStep), true);
  assert.equal(Number.isInteger(third.autoUnloadedThisTurn[0].lastCalledTurn), true);
  assert.equal(Number.isInteger(third.autoUnloadedThisTurn[0].lastCalledStep), true);
  assert.match(third.autoUnloaded[0].message, /长时间未被调用/);
});

test('tool_unload removes named tools and reports headroom', async () => {
  const f = fixture();
  const a = f.create();
  await f.search(a, { query: 'bash' });
  const out = await f.unloadTool(a, { names: ['bash'] });
  assert.equal(out.unloaded.length, 1);
  assert.deepEqual(out.loaded, []);
  assert.equal(out.headroom, 16);
  assert.equal(f.visible(a).some(t => t.name === 'bash'), false);
});

test('turn/start resets exception latch and loading is isolated per agent', async () => {
  const f = fixture();
  const a = f.create();
  const b = f.create({ sessionId: 'sess-2' });
  f.event({ type: 'turn/start', data: { turn: 1 } });
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'bash' } });
  const outA = await f.search(a, { query: 'bash' });
  const outB = await f.search(b, { query: 'bash' });
  assert.deepEqual(outA.selected, ['bash']);
  assert.deepEqual(outB.selected, ['bash']);
  f.event({ type: 'turn/start', data: { turn: 2 } });
  const reset = await f.search(a, { query: '' });
  assert.equal(reset.capacity, 16);
  assert.equal(reset.exceptionLatched, false);
});

test('tool schemas are DSH-compatible and carry the resident facts', () => {
  const f = fixture();
  const a = f.create();
  const search = f.visible(a).find(t => t.name === 'tool_search');
  const unload = f.visible(a).find(t => t.name === 'tool_unload');
  assert.match(search.description, /TOOL DISCOVERY CONTRACT/);
  assert.match(unload.description, /TOOL DISCOVERY CONTRACT/);
  assert(!JSON.stringify(search.output.schema).includes('"type":['));
  assert(!JSON.stringify(unload.output.schema).includes('"type":['));
});

test('evicting the only loaded tool does not clear the turn latch', async () => {
  const f = fixture();
  const a = f.create();
  f.event({ type: 'turn/start', data: { turn: 1 } });
  await f.search(a, { query: 'bash', limit: 1 });
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'bash' } });
  const before = await f.search(a, { query: 'bash', limit: 1 });
  assert.equal(before.exceptionLatched, true);
  const out = await f.search(a, { query: 'tool_', limit: 24 });
  assert.equal(out.capacity, 24);
  assert.equal(out.exceptionLatched, true);
  assert.equal(out.selected.length, 24);
  assert.equal(out.autoUnloaded.some(x => x.name === 'bash'), true);
});

test('two agent sessions do not share selected state or catalog activation', async () => {
  const f = fixture();
  const a = f.create();
  const b = f.create({ sessionId: 'sess-2' });
  await f.search(a, { query: 'bash', limit: 1 });
  const b0 = await f.search(b, { query: '' });
  assert.deepEqual(b0.selected, []);
  const b1 = await f.search(b, { query: 'generate_image', limit: 1 });
  assert.deepEqual(b1.selected, ['generate_image']);
  const a1 = await f.search(a, { query: '' });
  assert.deepEqual(a1.selected, ['bash']);
});

test('catalog changes are seen by a new agent, not retroactively by an existing one', async () => {
  const f = fixture();
  const a = f.create();
  f.catalog.push({ name: 'late_tool', description: 'Added after agent creation' });
  const old = await f.search(a, { query: '' });
  assert.equal(old.totalTools, 32);
  const b = f.create({ sessionId: 'sess-2' });
  const next = await f.search(b, { query: '' });
  assert.equal(next.totalTools, 33);
});
