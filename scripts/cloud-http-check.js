import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cookie } from '../src/cloud-auth.js';
import { withWorkspace } from '../src/cloud-store.js';

assert.equal(process.env.RIDDLEMASTER_CLOUD_CHECK, 'synthetic-only');
const config = JSON.parse(readFileSync('work/cloud/config.json', 'utf8'));
process.env.RIDDLEMASTER_SERVER_SECRET = config.secret;
process.env.RIDDLEMASTER_WEB_ORIGIN = config.origin;
const owner = process.argv[2];
const headers = { Cookie: cookie(owner, 'check-session').split(';')[0] };
const list = await fetch(config.origin + '/api/cases', { headers });
assert.equal(list.status, 200);
const cases = await list.json();
assert.equal(cases.length, 1);
const response = await fetch(config.origin + '/api/cases/' + cases[0].id, { headers });
assert.equal(response.status, 200);
const investigation = await response.json();
const source = investigation.artifacts.find(a => a.operation === 'import_text');
assert(source?.url.startsWith(config.origin + '/w/' + owner + '/media/'));
const file = await fetch(source.url);
assert.equal(file.status, 200);
assert.equal(await file.text(), 'U0FWRUQgQ0xVRQ==');
const denied = await fetch(config.origin + '/api/cases/' + cases[0].id);
assert.equal(denied.status, 401);
const tampered = new URL(source.url); tampered.searchParams.set('token', '0'.repeat(64));
assert.equal((await fetch(tampered)).status, 403);
const mutation = await fetch(config.origin + '/api/cases/' + cases[0].id + '/player-confirmation', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
assert.equal(mutation.status, 403);
const run = investigation.runs.find(r => r.status === 'running');
if (run) {
  const capability = await withWorkspace(owner, false, store => {
    // Dynamic import keeps the check using the application's actual capability generator.
    return import('../src/minds.js').then(minds => minds.runCapability(store, investigation.id, run.id));
  });
  const finished = await fetch(config.origin + '/w/' + owner + '/tools/finish_investigation', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` }, body: JSON.stringify({ case_id: investigation.id, run_id: run.id, request_id: randomUUID(), params: { summary: 'The saved clue reads SAVED CLUE. The answer remains unconfirmed.' } }) });
  assert.equal(finished.status, 200);
  assert((await finished.json()).say.includes(config.origin + '/workspace?case='));
}
console.log(JSON.stringify({ status: 'passed', cloud_cases: true, signed_media: true, anonymous_access_rejected: true, tampered_media_rejected: true, cross_origin_mutation_rejected: true, cloud_tool: Boolean(run), integration: 'HTTP and private storage; real OAuth/native chat still required' }));
