import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { withWorkspace } from '../src/cloud-store.js';
import { cookie, browserSession, checkSession, saveTokens, storedTokens, workspaceRuntime } from '../src/cloud-auth.js';
import { runCapability, completeAgentLink, prepareAgentLink, agentLinkAuthorized, nativeSourceMessage, config } from '../src/minds.js';

// Runs against an explicitly selected private test Blob store; never uses real account data.
assert.equal(process.env.RIDDLEMASTER_CLOUD_CHECK, 'synthetic-only');
process.env.RIDDLEMASTER_SERVER_SECRET ||= randomBytes(32).toString('hex');
process.env.RIDDLEMASTER_WEB_ORIGIN ||= 'https://riddlemaster.example';
const a = randomUUID(), b = randomUUID();
const created = await withWorkspace(a, true, async store => {
  store.setSetting('cloud_owner', a); store.setSetting('cloud_session', 'check-session'); store.setSetting('mind_id', randomUUID());
  const human = randomUUID();
  store.setSetting('cloud_human_id', human);
  workspaceRuntime(store, a, () => {
    assert.equal(config().MINDS_OWNER_ID, a);
    assert.equal(config().MINDS_HUMAN_ID, human);
    assert(nativeSourceMessage({ senderType: 1, senderId: human, fingerprint: 'synthetic-source', messageText: 'U0FWRUQgQ0xVRQ==' }, config().MINDS_HUMAN_ID));
    assert.equal(nativeSourceMessage({ senderType: 1, senderId: a, fingerprint: 'wrong-owner', messageText: 'U0FWRUQgQ0xVRQ==' }, config().MINDS_HUMAN_ID), null);
  });
  saveTokens(store, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 1000 });
  const result = await store.startInvestigation(randomUUID(), { source_text: 'U0FWRUQgQ0xVRQ==' }, true);
  store.setSetting(`native_alias:${result.case_id}`, 'webapp:synthetic');
  return { ...result, artifact: result.state.artifacts[0], capability: runCapability(store, result.case_id, result.run_id) };
});
await Promise.all([1, 2].map(() => withWorkspace(a, true, async store => {
  const count = Number(store.setting('check_counter') || 0);
  await new Promise(done => setTimeout(done, 150));
  store.setSetting('check_counter', String(count + 1));
})));
await withWorkspace(a, false, async store => {
  assert.equal(store.setting('check_counter'), '2');
  assert.equal(storedTokens(store).refreshToken, 'synthetic-refresh');
  assert.equal((await store.file(created.artifact.id)).toString(), 'U0FWRUQgQ0xVRQ==');
  const signed = cookie(a, 'check-session').split(';')[0];
  checkSession(store, browserSession({ headers: { cookie: signed } }));
  assert.throws(() => browserSession({ headers: { cookie: signed + 'x' } }));
  assert.equal(runCapability(store, created.case_id, created.run_id), created.capability);
});
await withWorkspace(b, true, store => { assert.equal(store.listCases().length, 0); assert.notEqual(runCapability(store, created.case_id, created.run_id), created.capability); });
const request = randomUUID();
await withWorkspace(a, true, store => store.call(created.case_id, created.run_id, request, 'check_candidate', { candidate: 'SAVED CLUE' }));
await withWorkspace(a, true, async store => {
  await store.call(created.case_id, created.run_id, request, 'check_candidate', { candidate: 'SAVED CLUE' });
  assert.equal(store.db.prepare('SELECT used FROM attempts WHERE case_id=?').get(created.case_id).used, 1);
  const transformed = await store.call(created.case_id, created.run_id, randomUUID(), 'transform_artifact', { artifact_id: created.artifact.id, operation: 'base64' });
  assert.equal(transformed.text, 'SAVED CLUE');
  const code = prepareAgentLink(store);
  workspaceRuntime(store, a, () => {
    const link = completeAgentLink(store, { code, request_id: randomUUID() });
    assert(agentLinkAuthorized(store, `Bearer ${link.link_token}`));
  });
});
await withWorkspace(a, false, store => assert.equal(store.getCase(created.case_id).artifacts.length, 2));
console.log(JSON.stringify({ status: 'passed', concurrent_writes: 2, owner_isolation: true, durable_artifact: true, retry_budget_retained: true, remote_transform: true, cookie_tamper_rejected: true, synthetic_owners: [a, b] }));
