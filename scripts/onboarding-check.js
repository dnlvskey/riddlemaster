import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');
const saved = new Map(), nodes = new Map(), minds = new Map();
let owner = 'first-owner', created = 0;
const client = {
  listMinds: async () => minds.get(owner) || [],
  checkMindName: async () => ({ isAvailable: true }),
  awakenMind: async ({ name }) => {
    const mind = { mindId: `test-mind-${++created}`, name };
    minds.set(owner, [mind]); return mind;
  },
};
const create = runInNewContext(source.slice(source.indexOf('async function createInvestigator'), source.indexOf('async function safely')) + '\ncreateInvestigator;', {
  busy: false, config: { clientId: 'test-client' }, oauth: { getAccessToken: async () => 'mock', client },
  parseUserIdFromAccessToken: () => owner, crypto: { randomUUID: () => `name000${created}-test` }, URL,
  $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); }, status() {},
  localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
});
await create(); assert.equal(created, 1); assert.match(nodes.get('open-mind').href, /mindId=test-mind-1/);
await create(); assert.equal(created, 1, 'A retry must reuse the owned Mind');
owner = 'second-owner'; await create(); assert.equal(created, 2);
assert.equal(saved.size, 2, 'Different accounts must keep separate setup state');
assert.match(nodes.get('open-mind').href, /mindId=test-mind-2/);
client.listMinds = async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); };
await assert.rejects(create(), { status: 401 }); assert.equal(created, 2);
assert.equal(nodes.get('connect').disabled, false);
console.log(JSON.stringify({ onboarding: 'passed', checks: 'owned Mind read-back, no duplicate on retry, separate account state, failed authentication', actual_mind: false, network: 'none' }));
