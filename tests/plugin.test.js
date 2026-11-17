import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function fixture(options = {}) {
  const handlers = new Map();
  const effects = [];
  const sections = [];
  const agents = new Map();
  const catalog = [
    { name: 'run_code', description: 'PTC transport' },
    { name: 'bash', description: 'Run shell commands in the workspace.' },
    { name: 'read_image', description: 'Read an image file into the conversation.' },
    { name: 'gated_tool', description: 'Render document pages as images.' },
    { name: 'plain_tool', description: 'A plain capability with no activation.' },
  ];
  for (let i = 0; i < 30; i += 1) catalog.push({ name: 'tool_' + String(i).padStart(2, '0'), description: 'Fixture tool ' + i });
  const visible = (agent, toolSet) => {
    const state = agents.get(agent);
    return catalog.filter(t => t.name === 'run_code'
      || (state.masks.every(m => m.has(t.name)) && !state.denied.has(t.name) && (toolSet === undefined || !state.whenFalse.has(t.name))))
      .concat([...state.own.values()]);
  };
  const ctx = {
    tools: { schemas: visible, get: (name, agent) => visible(agent).find(t => t.name === name) },
    systemPrompt: {
      getSectionOrder: () => 700,
      section: definition => { sections.push(definition); return () => {}; },
    },
    on: (event, callback) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(callback);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter(x => x !== callback));
      };
    },
    effect: fn => { effects.push(fn()); },
  };
  function create({ ptc = true, denied = [], whenFalse = [], sessionId = 'sess-1', agentPreset = ptc ? 'ptc' : 'standard', runCodeInSchemas = ptc, executorPtc = false } = {}) {
    const agent = { session: { id: sessionId, header: { id: sessionId, agentPreset } } };
    const state = { own: new Map(), masks: [], denied: new Set(denied), whenFalse: new Set(whenFalse) };
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
    if (!runCodeInSchemas) ctx.tools.schemas = (a, toolSet) => original(a, toolSet).filter(t => t.name !== 'run_code');
    if (executorPtc) ctx.tools.selectExecutor = () => ({ describe: () => ({ schemas: [{ name: 'run_code' }] }) });
    for (const handler of handlers.get('agent/created') ?? []) handler({ agent });
    ctx.tools.schemas = original;
    ctx.tools.selectExecutor = originalExecutor;
    return agent;
  }
  apply(ctx, { permanentTools: ['bash'], ...options });
  function event(payload) {
    const session = { header: { id: payload.sessionId ?? 'sess-1' } };
    for (const handler of handlers.get('session/event') ?? []) handler(session, payload);
  }
  const execFor = (agent, toolSet) => ({ agent, signal: new AbortController().signal, ...(toolSet === undefined ? {} : { toolSet }) });
  const call = (tool, agent, args, toolSet = {}) => ctx.tools.get(tool, agent).execute(args, execFor(agent, toolSet));
  return {
    create, visible, agents, handlers, catalog, sections, unload: () => effects.forEach(fn => fn()), event, call, execFor,
    search: (agent, args, toolSet = {}) => call('tool_search', agent, args, toolSet),
    load: (agent, args, toolSet = {}) => call('tool_load', agent, args, toolSet),
    unloadTool: (agent, args) => call('tool_unload', agent, args),
    inventory: (agent, args) => call('tool_inventory', agent, args),
    requireTool: (agent, args) => call('tool_require', agent, args),
  };
}

const HOST_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
const HOST_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertHostSubset(schema, path) {
  assert.ok(isPlainRecord(schema), path + ' must be a schema object');
  for (const key of Object.keys(schema)) {
    assert.ok(HOST_KEYWORDS.has(key), path + '.' + key + ' is outside the host JSON-schema subset');
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
  if (schema.type === 'object') {
    if (Object.hasOwn(schema, 'properties')) {
      for (const [key, value] of Object.entries(schema.properties)) assertHostSubset(value, path + '.properties.' + key);
    }
    if (Object.hasOwn(schema, 'required')) {
      for (const key of schema.required) {
        assert.equal(isPlainRecord(schema.properties) && Object.hasOwn(schema.properties, key), true, path + '.required names an undeclared property ' + key);
      }
    }
  }
  if (schema.type === 'array') {
    assert.ok(isPlainRecord(schema.items), path + '.items is required for arrays');
    assertHostSubset(schema.items, path + '.items');
  }
}

test('does not activate for a standard agent', () => {
  const f = fixture();
  const a = f.create({ ptc: false });
  assert.equal(f.visible(a).some(t => t.name === 'tool_search'), false);
});

test('registers search/load/unload/inventory/require for PTC', () => {
  const f = fixture();
  const a = f.create();
  const names = f.visible(a).map(t => t.name);
  for (const name of ['tool_search', 'tool_load', 'tool_unload', 'tool_inventory', 'tool_require']) assert.ok(names.includes(name), name);
});

test('search returns unloaded matches and loads nothing', async () => {
  const f = fixture();
  const a = f.create();
  const out = await f.search(a, { query: 'read_image' });
  assert.equal(out.matched, 1);
  assert.equal(out.tools[0].name, 'read_image');
  assert.equal(out.selected, undefined);
  const inv = await f.inventory(a);
  assert.deepEqual(inv.selected, []);
});

test('search by exact name returns one row with its description', async () => {
  const f = fixture();
  const a = f.create();
  const out = await f.search(a, { query: 'read_image' });
  assert.equal(out.matched, 1);
  assert.equal(out.tools[0].name, 'read_image');
  assert.match(out.tools[0].description, /image file/);
});

test('empty query is rejected', async () => {
  const f = fixture();
  const a = f.create();
  await assert.rejects(() => f.search(a, { query: '' }));
  await assert.rejects(() => f.search(a, {}));
});

test('search excludes loaded tools and reports skippedLoaded', async () => {
  const f = fixture();
  const a = f.create();
  await f.load(a, { names: 'read_image' });
  const out = await f.search(a, { query: 'read_image' });
  assert.equal(out.matched, 0);
  assert.equal(out.skippedLoaded, 1);
});

test('search marks configured gated tools with their activation skill', async () => {
  const f = fixture({ gatedTools: { gated_tool: 'demo' } });
  const a = f.create();
  const out = await f.search(a, { query: 'gated_tool' });
  assert.equal(out.tools[0].gated, true);
  assert.equal(out.tools[0].activationSkill, 'demo');
});

test('load loads exact names and applies the restriction', async () => {
  const f = fixture();
  const a = f.create();
  const out = await f.load(a, { names: ['tool_00', 'tool_01'] });
  assert.deepEqual(out.loaded.sort(), ['tool_00', 'tool_01']);
  const inv = await f.inventory(a);
  assert.deepEqual(inv.selected.sort(), ['tool_00', 'tool_01']);
});

test('load is idempotent', async () => {
  const f = fixture();
  const a = f.create();
  await f.load(a, { names: 'tool_00' });
  const again = await f.load(a, { names: 'tool_00' });
  assert.deepEqual(again.alreadyLoaded, ['tool_00']);
  assert.deepEqual(again.loaded, []);
});

test('load reports unknown names', async () => {
  const f = fixture();
  const a = f.create();
  const out = await f.load(a, { names: ['no_such_tool'] });
  assert.deepEqual(out.unknown, ['no_such_tool']);
});

test('load refuses configured gated tools', async () => {
  const f = fixture({ gatedTools: { gated_tool: 'demo' } });
  const a = f.create();
  const out = await f.load(a, { names: 'gated_tool' });
  assert.equal(out.refused[0].name, 'gated_tool');
  assert.equal(out.refused[0].reason, 'gated');
  assert.equal(out.refused[0].activationSkill, 'demo');
  const inv = await f.inventory(a);
  assert.deepEqual(inv.selected, []);
});

test('load enforces the per-call batch limit', async () => {
  const f = fixture({ loadBatchMax: 2 });
  const a = f.create();
  const out = await f.load(a, { names: ['tool_00', 'tool_01', 'tool_02'] });
  assert.equal(out.loaded.length, 2);
  assert.equal(out.refused.some(item => item.reason === 'batch-limit'), true);
});

test('load evicts the oldest inactive tool when capacity is full', async () => {
  const f = fixture({ maxLoaded: 2, permanentTools: ['bash'] });
  const a = f.create();
  await f.load(a, { names: ['tool_00'] });
  await f.load(a, { names: ['tool_01'] });
  const out = await f.load(a, { names: ['tool_02'] });
  assert.deepEqual(out.loaded, ['tool_02']);
  assert.equal(out.evicted.length, 1);
  assert.equal(out.evicted[0].reason, 'inactivity');
});

test('reconcile discovers an unconfigured gated tool after load', async () => {
  const f = fixture();
  const a = f.create({ whenFalse: ['gated_tool'] });
  const first = await f.load(a, { names: 'gated_tool' });
  assert.deepEqual(first.loaded, ['gated_tool']);
  f.event({ type: 'step/start', data: { step: 1 } });
  const out = await f.search(a, { query: 'plain_tool' });
  assert.deepEqual(out.unloadedGated, ['gated_tool']);
  const inv = await f.inventory(a);
  assert.deepEqual(inv.gated, ['gated_tool']);
  assert.deepEqual(inv.selected, []);
  const second = await f.load(a, { names: 'gated_tool' });
  assert.equal(second.refused[0].reason, 'gated');
});

test('reconcile skips tools loaded in the current step', async () => {
  const f = fixture();
  const a = f.create({ whenFalse: ['gated_tool'] });
  await f.load(a, { names: 'gated_tool' });
  const same = await f.search(a, { query: 'plain_tool' });
  assert.deepEqual(same.unloadedGated, []);
  f.event({ type: 'step/start', data: { step: 1 } });
  const next = await f.search(a, { query: 'plain_tool' });
  assert.deepEqual(next.unloadedGated, ['gated_tool']);
});

test('skill event clears gating and auto-loads mapped tools', async () => {
  const f = fixture({ gatedTools: { gated_tool: 'demo' }, requiredToolsBySkill: { demo: ['gated_tool'] } });
  const a = f.create();
  f.event({ type: 'tool/ptc-dispatch', sessionId: 'sess-1', data: { name: 'skill', arguments: JSON.stringify({ name: 'demo' }), turn: 1, step: 1, isError: false } });
  const inv = await f.inventory(a);
  assert.deepEqual(inv.gated, []);
  assert.deepEqual(inv.selected, ['gated_tool']);
});

test('instantiate index section renders names, gated marks, and no descriptions', async () => {
  const f = fixture({ gatedTools: { gated_tool: 'demo' } });
  const a = f.create();
  assert.equal(f.sections.length, 1);
  const text = f.sections[0].text({ scope: a });
  assert.match(text, /TOOL INDEX/);
  assert.match(text, /read_image/);
  assert.match(text, /gated_tool\[demo\]/);
  assert.equal(text.includes('Render document pages'), false);
  assert.equal(f.sections[0].text({ scope: {} }), '');
});

test('inventory exposes counters, gating and admission state', async () => {
  const f = fixture();
  const a = f.create();
  await f.search(a, { query: 'tool_00' });
  const inv = await f.inventory(a);
  assert.equal(inv.searched, 1);
  assert.equal(typeof inv.admissionChecked, 'boolean');
  assert.ok(Array.isArray(inv.gated));
});

test('unload removes a tool and it can be loaded again', async () => {
  const f = fixture();
  const a = f.create();
  await f.load(a, { names: 'tool_00' });
  const unloaded = await f.unloadTool(a, { names: ['tool_00'] });
  assert.equal(unloaded.unloaded.length, 1);
  const again = await f.load(a, { names: 'tool_00' });
  assert.deepEqual(again.loaded, ['tool_00']);
});

test('tool_require pins loaded tools', async () => {
  const f = fixture();
  const a = f.create();
  await f.load(a, { names: ['tool_00', 'tool_01'] });
  const pinned = await f.requireTool(a, { names: ['tool_00'] });
  assert.deepEqual(pinned.required, ['tool_00']);
  const inv = await f.inventory(a);
  assert.equal(inv.autoUnloadMax, 1);
});

test('every registered output schema stays inside the host subset', () => {
  const f = fixture();
  const a = f.create();
  for (const name of ['tool_search', 'tool_load', 'tool_unload', 'tool_require', 'tool_inventory']) {
    const tool = f.visible(a).find(t => t.name === name);
    assertHostSubset(tool.output.schema, name);
  }
});
