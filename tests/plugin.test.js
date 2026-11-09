import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function fixture(options = {}) {
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
  function create({ ptc = true, denied = [], sessionId = 'sess-1', agentPreset = ptc ? 'ptc' : 'standard', runCodeInSchemas = ptc, executorPtc = false } = {}) {
    const agent = { session: { id: sessionId, header: { id: sessionId, agentPreset } } };
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
    const original = ctx.tools.schemas;
    const originalExecutor = ctx.tools.selectExecutor;
    if (!runCodeInSchemas) {
      ctx.tools.schemas = a => original(a).filter(t => t.name !== 'run_code');
    }
    if (executorPtc) {
      ctx.tools.selectExecutor = () => ({ describe: () => ({ schemas: [{ name: 'run_code' }] }) });
    }
    for (const handler of handlers.get('agent/created') ?? []) handler({ agent });
    ctx.tools.schemas = original;
    ctx.tools.selectExecutor = originalExecutor;
    return agent;
  }
  apply(ctx, { permanentTools: [], ...options });
  function event(payload) {
    const session = { header: { id: payload.sessionId ?? 'sess-1' } };
    for (const handler of handlers.get('session/event') ?? []) handler(session, payload);
  }
  return {
    create, visible, agents, handlers, catalog, unload: () => effects.forEach(fn => fn()), event,
    search: (agent, args) => ctx.tools.get('tool_search', agent).execute(args, { agent, signal: new AbortController().signal }),
    unloadTool: (agent, args) => ctx.tools.get('tool_unload', agent).execute(args, { agent, signal: new AbortController().signal }),
    inventory: (agent, args) => ctx.tools.get('tool_inventory', agent).execute(args ?? {}, { agent, signal: new AbortController().signal }),
    requireTool: (agent, args) => ctx.tools.get('tool_require', agent).execute(args ?? {}, { agent, signal: new AbortController().signal }),
  };
}

const HOST_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const HOST_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Mirror of the host's enforced JSON-schema subset (dsh-tools 0.2.2,
// assertSupportedJsonSchema). Tool OUTPUT schemas must stay inside it or the
// host rejects them while creating a session; input parameter schemas are
// handled by a different path and are intentionally not checked here.
function assertHostSubset(schema, path) {
  assert.ok(isPlainRecord(schema), path + ' must be a schema object');
  for (const key of Object.keys(schema)) {
    assert.ok(HOST_KEYWORDS.has(key), path + '.' + key + ' is outside the host JSON-schema subset');
  }
  if (Object.hasOwn(schema, 'description')) {
    assert.equal(typeof schema.description, 'string', path + '.description must be a string');
  }
  if (Object.hasOwn(schema, 'title')) {
    assert.equal(typeof schema.title, 'string', path + '.title must be a string');
  }
  if (Object.hasOwn(schema, 'additionalProperties')) {
    assert.equal(typeof schema.additionalProperties, 'boolean', path + '.additionalProperties must be a boolean');
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  assert.equal(hasType && hasOneOf, false, path + ' cannot declare both type and oneOf');
  assert.equal(hasType || hasOneOf, true, path + ' must declare type or oneOf');
  if (hasOneOf) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, path + '.oneOf must have at least two schemas');
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      assert.equal(Object.hasOwn(schema, key), false, path + '.' + key + ' is not supported beside oneOf');
    }
    schema.oneOf.forEach((entry, index) => assertHostSubset(entry, path + '.oneOf[' + index + ']'));
    return;
  }
  assert.ok(HOST_TYPES.has(schema.type), path + '.type must be one scalar type');
  const ownerOf = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array' };
  for (const [key, owner] of Object.entries(ownerOf)) {
    if (Object.hasOwn(schema, key)) {
      assert.equal(schema.type, owner, path + '.' + key + ' requires type ' + owner);
    }
  }
  if (schema.type === 'object') {
    if (Object.hasOwn(schema, 'properties')) {
      assert.ok(isPlainRecord(schema.properties), path + '.properties must be an object');
      for (const [key, value] of Object.entries(schema.properties)) {
        assertHostSubset(value, path + '.properties.' + key);
      }
    }
    if (Object.hasOwn(schema, 'required')) {
      assert.ok(Array.isArray(schema.required), path + '.required must be an array');
      for (const key of schema.required) {
        assert.equal(typeof key, 'string', path + '.required entries must be strings');
        assert.equal(
          isPlainRecord(schema.properties) && Object.hasOwn(schema.properties, key),
          true,
          path + '.required names an undeclared property ' + key,
        );
      }
    }
  }
  if (schema.type === 'array') {
    assert.ok(isPlainRecord(schema.items), path + '.items is required for arrays');
    assertHostSubset(schema.items, path + '.items');
  }
  if (Object.hasOwn(schema, 'enum')) {
    assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, path + '.enum must be a non-empty array');
  }
  if (Object.hasOwn(schema, 'const')) {
    assert.equal(isPlainRecord(schema.const) || Array.isArray(schema.const), false, path + '.const must be a scalar');
  }
}

test('index is complete and empty query loads nothing', async () => {
  const f = fixture();
  const a = f.create();
  assert.deepEqual(f.visible(a).map(t => t.name).sort(), ['run_code', 'tool_inventory', 'tool_require', 'tool_search', 'tool_unload']);
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

test('activates for a 0.2.2-style PTC agent without run_code in the registry', async () => {
  const f = fixture();
  const a = f.create({ runCodeInSchemas: false });
  assert.equal(f.visible(a).some(t => t.name === 'tool_search'), true);
  const out = await f.search(a, { query: 'bash' });
  assert.deepEqual(out.selected, ['bash']);
});

test('does not activate for a standard agent without run_code', () => {
  const f = fixture();
  const a = f.create({ ptc: false });
  assert.equal(f.visible(a).some(t => t.name === 'tool_search'), false);
});

test('recognizes the PTC executor when the preset is absent', () => {
  const f = fixture();
  const a = f.create({ ptc: false, agentPreset: 'custom', executorPtc: true });
  assert.equal(f.visible(a).some(t => t.name === 'tool_search'), true);
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

test('tool inventory reports memory_read availability without requiring it', async () => {
  const f = fixture();
  const a = f.create();
  assert.equal((await f.inventory(a)).memoryRead, 'unavailable');
  f.catalog.push({ name: 'memory_read', description: 'Original event reader' });
  const b = f.create({ sessionId: 'sess-2' });
  assert.equal((await f.inventory(b)).memoryRead, 'available');
});

test('requiredToolsBySkill pins catalog tools when the named skill is called', async () => {
  const f = fixture({ requiredToolsBySkill: { 'midform-writing': ['tool_00', 'missing_tool'] } });
  const a = f.create();
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'skill', arguments: { name: 'midform-writing' } } });
  const inv = await f.inventory(a);
  assert.deepEqual(inv.required, ['tool_00']);
  const cleared = await f.requireTool(a, { clear: true });
  assert.deepEqual(cleared.required, []);
});

test('tool_require pins tools so inactivity auto-unload skips them', async () => {
  const f = fixture();
  const a = f.create();
  const first = await f.search(a, { query: 'tool_', limit: 16 });
  const pinned = first.selected.slice(0, 2);
  const pinnedOut = await f.requireTool(a, { names: pinned });
  assert.deepEqual(pinnedOut.required, [...pinned].sort());
  f.event({ type: 'turn/start', data: { turn: 1 } });
  for (const name of first.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  await f.search(a, { query: 'tool_', limit: 8 });
  await f.search(a, { query: 'tool_', limit: 1 });
  const inv = await f.inventory(a);
  for (const name of pinned) assert.equal(inv.selected.includes(name), true);
  assert.equal(inv.required.includes(pinned[0]), true);
});


test('permanent tools stay visible without loading and do not consume capacity', async () => {
  const f = fixture({ permanentTools: ['bash'] });
  const a = f.create();
  assert.equal(f.visible(a).some(t => t.name === 'bash'), true);
  const inv = await f.inventory(a);
  assert.deepEqual(inv.permanent, ['bash']);
  assert.deepEqual(inv.selected, []);
  assert.deepEqual(inv.loaded, ['bash']);
  assert.equal(inv.capacity, 16);
  assert.equal(inv.headroom, 16);
  const out = await f.search(a, { query: 'bash' });
  assert.deepEqual(out.selected, []);
  assert.deepEqual(out.permanent, ['bash']);
  assert.equal(out.notLoaded.includes('bash'), false);
  const unloaded = await f.unloadTool(a, {});
  assert.deepEqual(unloaded.unloaded, []);
  assert.deepEqual(unloaded.permanent, ['bash']);
  assert.equal(f.visible(a).some(t => t.name === 'bash'), true);
});

test('namesOnly returns compact available names and does not load', async () => {
  const f = fixture({ permanentTools: [] });
  const a = f.create();
  const out = await f.search(a, { query: '', namesOnly: true });
  assert.equal(out.mode, 'names');
  assert.equal(out.selected.length, 0);
  assert.equal(out.availableCount, 32);
  assert.equal(out.tools.every(t => t.description === ''), true);
  assert.equal(out.notLoaded.length, 32);
  assert.equal(out.notLoaded.includes('bash'), true);
});

test('control-plane results instruct the next request', async () => {
  const f = fixture({ permanentTools: [] });
  const a = f.create();
  const search = await f.search(a, { query: 'bash' });
  assert.equal(search.controlPlane, true);
  assert.equal(search.nextRequest, true);
  assert.match(search.instruction, /next model request/i);
  const unload = await f.unloadTool(a, {});
  assert.equal(unload.controlPlane, true);
  assert.equal(unload.nextRequest, true);
  const require = await f.requireTool(a, { names: [] });
  assert.equal(require.controlPlane, true);
  assert.equal(require.nextRequest, true);
});


test('same-step control and business calls are audited without blocking', async () => {
  const f = fixture({ permanentTools: [] });
  const a = f.create();
  f.event({ type: 'turn/start', data: { turn: 1 } });
  f.event({ type: 'step/start', data: { step: 1 } });
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'tool_search' } });
  f.event({ type: 'tool/ptc-dispatch', data: { name: 'bash' } });
  const inv = await f.inventory(a);
  assert.match(inv.controlViolation, /mixed/);
  f.event({ type: 'turn/start', data: { turn: 2 } });
  const next = await f.inventory(a);
  assert.equal(next.controlViolation, '');
});


test('automatic unloading never removes a permanent tool', async () => {
  const f = fixture({ permanentTools: ['bash'] });
  const a = f.create();
  const first = await f.search(a, { query: 'tool_', limit: 16 });
  f.event({ type: 'turn/start', data: { turn: 1 } });
  for (const name of first.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  const second = await f.search(a, { query: 'tool_', limit: 8 });
  assert.equal(second.selected.length, 24);
  for (const name of second.selected) f.event({ type: 'tool/ptc-dispatch', data: { name } });
  const third = await f.search(a, { query: 'tool_', limit: 1 });
  assert.equal(third.selected.length, 24);
  assert.equal(third.autoUnloaded.length, 1);
  assert.deepEqual(third.permanent, ['bash']);
  assert.equal(f.visible(a).some(tool => tool.name === 'bash'), true);
});


test('every registered output schema stays inside the host JSON-schema subset', () => {
  const f = fixture({ permanentTools: ['bash'] });
  const a = f.create();
  for (const name of ['tool_search', 'tool_unload', 'tool_require', 'tool_inventory']) {
    const tool = f.visible(a).find(entry => entry.name === name);
    assert.ok(tool, name + ' should be registered');
    assertHostSubset(tool.output.schema, name + '.output');
  }
});

