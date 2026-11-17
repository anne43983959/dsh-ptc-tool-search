import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTools, validateSearch } from '../search.js';

const catalog = [
  { name: 'bash', description: 'Run terminal shell commands.' },
  { name: 'generate_image', description: 'Generate an image from a text prompt.' },
  { name: 'read_image', description: 'Read an existing image.' },
  { name: 'get_goal', description: 'Return the current goal, including the revision it requires.' },
];

test('exact callable name wins over description matches', () => {
  assert.deepEqual(rankTools(catalog, 'generate_image', 1).map(x => x.name), ['generate_image']);
});

test('capability words retrieve shell', () => {
  assert.deepEqual(rankTools(catalog, 'terminal shell', 2).map(x => x.name), ['bash']);
});

test('unmatched query returns nothing', () => {
  assert.deepEqual(rankTools(catalog, 'zzzznomatch', 2), []);
});

test('word boundaries keep revision from matching vision', () => {
  assert.deepEqual(rankTools(catalog, 'vision', 5).map(x => x.name), []);
});

test('name token matches a compound name', () => {
  assert.deepEqual(rankTools(catalog, 'read', 5).map(x => x.name), ['read_image']);
});

test('description token matches', () => {
  assert.deepEqual(rankTools(catalog, 'prompt', 5).map(x => x.name), ['generate_image']);
});

test('name hits rank above description hits', () => {
  const out = rankTools(catalog, 'image', 5).map(x => x.name);
  assert.deepEqual(out.slice(0, 2), ['generate_image', 'read_image']);
});

test('limit slices the ranked list', () => {
  assert.equal(rankTools(catalog, 'image', 1).length, 1);
});

test('validateSearch trims and rejects empty or long queries', () => {
  assert.deepEqual(validateSearch({ query: ' bash ' }, { maxQueryChars: 40 }), { query: 'bash' });
  assert.throws(() => validateSearch({ query: '' }, { maxQueryChars: 40 }));
  assert.throws(() => validateSearch({ query: 'x'.repeat(41) }, { maxQueryChars: 40 }));
});
