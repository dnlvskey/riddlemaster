import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { htmlText, readSource, sourceInput, readInput } from '../src/source.js';
import { Store, hash, toolNames } from '../src/store.js';
import { requireValue, transform } from '../src/operations.js';
import { nativeSourceMessage, queueNativeTask, claimNativeTask, runCapability, mediaToken } from '../src/minds.js';

if (process.argv.includes('--parsers')) {
  const decode = (text, operation) => transform(Buffer.from(text), 'text/plain', operation);
  const file = content_base64 => ({ files: [{ name: 'clue.txt', mime: 'text/plain', content_base64 }] });
  for (const [encoded, plain] of [['Zg==', 'f'], ['Zm8=', 'fo'], ['Zm9v', 'foo'], ['Zh==', 'f'], ['Zm9=', 'fo']]) {
    assert.equal((await readInput(file(encoded))).files[0].bytes.toString(), plain);
    assert.equal((await decode(encoded, 'base64')).buffer.toString(), plain);
  }
  for (const invalid of ['', '=', '====', 'Zg', 'Zg=', 'Z===', 'Z=g=', 'Zg==AAAA', '****', 'Zm9_', 'AAA\n', 'Zg==\n']) {
    assert.throws(() => sourceInput(file(invalid)), /Expected valid file bytes as Base64/);
  }
  assert.equal((await decode(' Zg==\r\n', 'base64')).buffer.toString(), 'f');
  for (const invalid of ['Zg', 'Zg=', 'Z===', 'Z=g=', 'Zg==AAAA', '****', 'Zm9_']) {
    await assert.rejects(decode(invalid, 'base64'), /Expected padded Base64/);
  }
  const limit = 4 * 1024 * 1024, bytes = Buffer.alloc(limit, 65);
  assert.deepEqual((await readInput(file(bytes.toString('base64')))).files[0].bytes, bytes);
  await assert.rejects(readInput(file(Buffer.alloc(limit + 1, 65).toString('base64'))), /File must contain/);
  assert.throws(() => sourceInput(file(Buffer.alloc(limit + 3, 65).toString('base64'))), /Expected valid file bytes/);
  assert.equal((await decode('QUFB'.repeat(limit / 4), 'base64')).buffer.length, limit * 3 / 4);
  assert.equal((await decode('.... .. / .-', 'morse')).buffer.toString(), 'HI A');
  assert.equal((await decode(' \t....\u00a0..\n/\u2003.-\r\n', 'morse')).buffer.toString(), 'HI A');
  for (const whitespace of [' ', '\t']) {
    assert.equal((await decode('....' + whitespace.repeat(limit - 6) + '..', 'morse')).buffer.toString(), 'HI');
  }
  for (const invalid of ['', '/', ' / .-', '.- /', '.- // -...', '.- / \t / -...', '......']) {
    await assert.rejects(decode(invalid, 'morse'), /Unknown Morse symbol/);
  }
  console.log(JSON.stringify({ parsers: 'passed', maxInputBytes: limit, network: 'none' }));
} else if (process.argv.includes('--html')) {
  // Mock both transport boundaries: these fixtures never resolve or contact a real host.
  const pages = new Map(), fetched = [];
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  https.request = (url, options, callback) => {
    assert(pages.has(url.href), `Unexpected source fetch: ${url.href}`);
    fetched.push(url.href);
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const page = pages.get(url.href), response = new EventEmitter();
      response.statusCode = 200; response.headers = { 'content-type': page.mime };
      response.destroy = error => response.emit('error', error);
      callback(response); response.emit('data', page.bytes); response.emit('end');
    });
    return request;
  };
  syncBuiltinESMExports();
  const page = (url, html) => pages.set(url, { mime: 'text/html', bytes: Buffer.from(html) });
  const source = 'https://example.com/puzzle';
  assert.equal(htmlText('<SCRIPT>hidden()</SCRIPT><style>hidden</style><noscript>hidden</noscript><P>Clue &amp; key &#65;</P><p>Next</p>'), 'Clue & key A\nNext');
  assert.equal(htmlText('one<br>two</div>three\n\n\nfour'), 'one\ntwo\nthree\n\nfour');
  assert.equal(htmlText('<script>Visible unfinished clue'), 'Visible unfinished clue');
  assert.equal(htmlText('A <unfinished'), 'A <unfinished');
  const limit = 4 * 1024 * 1024, started = performance.now();
  const owner = { senderType: 1, senderId: 'owner', fingerprint: 'clue' };
  const plain = '  Puzzle <A> · café\n  RVZJREVOQ0U=\n';
  assert.equal(nativeSourceMessage({ ...owner, messageText: plain }, 'owner').text, plain);
  assert.equal(nativeSourceMessage({ ...owner, messageText: '<P class="clue">one<BR/>two</P>' }, 'owner').text, 'one\ntwo');
  for (const tag of ['<a ', '<div ', '<A\t']) {
    const malformed = tag.repeat(Math.floor((limit - 4) / tag.length));
    assert.equal(nativeSourceMessage({ ...owner, messageText: '</p>' + malformed }, 'owner').text, malformed);
  }
  const punctuation = 'https://example.com/' + ','.repeat(limit - 21) + 'x';
  assert.equal(nativeSourceMessage({ ...owner, messageText: punctuation }, 'owner').url, punctuation);
  assert.equal(nativeSourceMessage({ ...owner, messageText: 'Check https://example.com/clue.,);]}' }, 'owner').url, 'https://example.com/clue');
  for (const input of ['<'.repeat(limit), '<script>'.repeat(limit / 8), '<style>'.repeat(Math.floor(limit / 7)), '<noscript>'.repeat(Math.floor(limit / 10)), '<title '.repeat(Math.floor(limit / 7)), '<meta '.repeat(Math.floor(limit / 6))]) {
    page(source, input);
    const result = await readSource(source);
    assert(result.files.some(file => file.operation === 'import_original'));
    assert.equal(result.title, 'example.com');
  }
  page(source, '<title>Clue &amp; key &#x41;</title><p>Visible clue</p>');
  assert.equal((await readSource(source)).title, 'Clue & key A');
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
  for (let i = 0; i < 6; i++) pages.set(`https://example.com/image-${i}.png`, { mime: 'image/png', bytes: png });
  page(source, '<p>1 < 2<img src="/image-0.png"></p>');
  assert.equal((await readSource(source)).files.filter(file => file.mime === 'image/png').length, 1);
  page(source, `<noscript><img src="/image-0.png"></noscript><img src="/image-0.png">` + Array.from({ length: 6 }, (_, i) => `<img src="/image-${i}.png">`).join('') + '<title>Late title</title><p>Clue</p>');
  fetched.length = 0;
  const ordinary = await readSource(source);
  assert.equal(ordinary.title, 'Late title');
  assert.equal(ordinary.files.filter(file => file.mime === 'image/png').length, 4);
  assert.equal(fetched.filter(url => url.includes('/image-')).length, 4);
  assert(ordinary.files.some(file => file.url === 'https://example.com/image-0.png'));
  assert(ordinary.source.warnings.some(warning => warning.includes('first four')));
  const post = 'https://x.com/owner/status/123';
  pages.set(`https://publish.x.com/oembed?url=${encodeURIComponent(post)}&omit_script=true`, { mime: 'application/json', bytes: Buffer.from(JSON.stringify({ html: '<p>X clue</p>', author_name: 'Owner' })) });
  page(post, Array.from({ length: 8 }, (_, i) => `<img src="https://example.com/image-${i}.png">`).join('') + Array.from({ length: 6 }, (_, i) => `<noscript><img src="https://pbs.twimg.com/media/clue-${i}.png"></noscript>`).join('') + '<meta property="og:video" content="video"><p>Supporting page text</p>');
  for (let i = 0; i < 6; i++) pages.set(`https://pbs.twimg.com/media/clue-${i}.png`, { mime: 'image/png', bytes: png });
  fetched.length = 0;
  const x = await readSource(post);
  assert.equal(x.files.find(file => file.operation === 'import_text').bytes.toString(), 'X clue');
  assert.equal(x.files.filter(file => file.mime === 'image/png').length, 4);
  assert.equal(fetched.filter(url => url.startsWith('https://example.com/')).length, 0);
  assert(x.source.warnings.some(warning => warning.includes('video')));
  assert(x.source.warnings.some(warning => warning.includes('first four')));
  console.log(JSON.stringify({ html: 'passed', maxInputBytes: limit, elapsedMs: Math.round(performance.now() - started), network: 'mocked' }));
} else {
  for (const mode of ['--parsers', '--html']) {
    const worker = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(worker.error);
    assert.equal(worker.status, 0, worker.stderr || worker.stdout);
    console.log(worker.stdout.trim());
  }
  const store = new Store(resolve(`security-check-${randomUUID()}`));
  try {
    const c = store.createCase('Security regression'), stageId = c.current_stage_id;
    const first = await store.upload(c.id, stageId, 'first.txt', 'text/plain', Buffer.from('first clue'));
    const second = await store.upload(c.id, stageId, 'second.txt', 'text/plain', Buffer.from('second clue'));
    const run = store.newRun(c.id, true);
    const call = (params, requestId = randomUUID()) => store.call(c.id, run.id, requestId, 'record_hypothesis', { text: 'Evidence-backed hypothesis', status: 'untested', ...params });
    const before = store.caseRow(c.id).state, eventCount = store.db.prepare('SELECT count(*) AS n FROM events').get().n;
    const escaped = JSON.parse(`["${first.id}","\\u${first.id.charCodeAt(0).toString(16).padStart(4, '0')}${first.id.slice(1)}"]`);
    const oversized = Array(100000).fill(first.id);
    assert(Buffer.byteLength(JSON.stringify(oversized)) < 6 * 1024 * 1024);
    for (const artifact_ids of [oversized, [first.id, first.id], escaped, Array.from({ length: 101 }, () => randomUUID()), Array(1), [null], [[first.id]], ['x'.repeat(10000)], 'not-an-array']) {
      await assert.rejects(call({ artifact_ids }), { status: 400 });
      assert.equal(store.caseRow(c.id).state, before);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, eventCount);
      assert.equal(store.run(run.id).calls, 0);
    }
    store.db.prepare('UPDATE runs SET calls=30 WHERE id=?').run(run.id);
    await assert.rejects(call({ artifact_ids: oversized }), { status: 400 });
    store.db.prepare('UPDATE runs SET calls=0 WHERE id=?').run(run.id);
    const requestId = randomUUID(), params = { artifact_ids: [second.id, first.id] }, recorded = await call(params, requestId);
    assert.equal(recorded.status, 'ok');
    assert.deepEqual(recorded.hypothesis.artifact_ids, params.artifact_ids);
    assert.deepEqual(await call(params, requestId), recorded);
    assert.equal(store.run(run.id).calls, 1);
    assert.equal((await call({})).status, 'ok');
    assert.equal((await call({ artifact_ids: null })).status, 'ok');
    const foreign = await call({ artifact_ids: [randomUUID()] });
    assert.equal(foreign.status, 'failed');
    assert.match(foreign.error, /active stage/);
    const saved = store.checkpoint(c.id, 'Safe snapshot');
    const updated = await call({ hypothesis_id: recorded.hypothesis.id, artifact_ids: [first.id], status: 'supported' });
    assert.equal(updated.status, 'ok');
    store.restore(c.id, saved.checkpoint_id);
    store.selectHypothesis(c.id, recorded.hypothesis.id);
    assert.equal(store.getCase(c.id).selected_hypothesis_id, recorded.hypothesis.id);
    const safeState = store.caseRow(c.id).state, unsafe = JSON.parse(safeState);
    const legacy = JSON.parse(safeState); legacy.stages[0].hypotheses[0].artifact_ids = [first.id, first.id];
    store.db.prepare('UPDATE cases SET state=? WHERE id=?').run(JSON.stringify(legacy), c.id);
    store.selectStage(c.id, stageId);
    const legacyCheckpoint = store.checkpoint(c.id, 'Bounded legacy duplicates');
    assert.equal((await call({ hypothesis_id: recorded.hypothesis.id, artifact_ids: [first.id] })).status, 'ok');
    store.restore(c.id, legacyCheckpoint.checkpoint_id);
    assert.deepEqual(store.getCase(c.id).stages[0].hypotheses[0].artifact_ids, [first.id, first.id]);
    store.db.prepare('UPDATE cases SET state=? WHERE id=?').run(safeState, c.id);
    unsafe.stages[0].hypotheses[0].artifact_ids = Array(101).fill(first.id);
    const unsafeState = JSON.stringify(unsafe), badCheckpoint = randomUUID();
    store.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?)').run(badCheckpoint, c.id, 'Legacy unsafe snapshot', unsafeState, new Date().toISOString());
    assert.throws(() => store.restore(c.id, badCheckpoint), { status: 400 });
    assert.equal(store.caseRow(c.id).state, safeState);
    const original = store.db.prepare('SELECT node,snapshot FROM hypothesis_nodes WHERE id=?').get(recorded.hypothesis.id);
    store.db.prepare('UPDATE hypothesis_nodes SET snapshot=? WHERE id=?').run(unsafeState, recorded.hypothesis.id);
    assert.throws(() => store.selectHypothesis(c.id, recorded.hypothesis.id), { status: 400 });
    assert.equal(store.caseRow(c.id).state, safeState);
    const unsafeNode = JSON.parse(original.node); unsafeNode.artifact_ids = Array(100000).fill(first.id);
    store.db.prepare('UPDATE hypothesis_nodes SET node=?,snapshot=? WHERE id=?').run(JSON.stringify(unsafeNode), original.snapshot, recorded.hypothesis.id);
    assert.throws(() => store.selectHypothesis(c.id, recorded.hypothesis.id), { status: 400 });
    const readRejected = await store.call(c.id, run.id, randomUUID(), 'get_case_state');
    assert.equal(readRejected.status, 'failed');
    assert(Buffer.byteLength(JSON.stringify(readRejected)) < 1000);
    assert(store.db.prepare('SELECT max(length(result)) AS bytes FROM requests').get().bytes < 20000);
    assert(store.db.prepare('SELECT max(length(result)) AS bytes FROM events').get().bytes < 20000);
    store.db.prepare('UPDATE hypothesis_nodes SET node=? WHERE id=?').run(original.node, recorded.hypothesis.id);
    store.db.prepare('UPDATE cases SET state=? WHERE id=?').run(unsafeState, c.id);
    const nodesBefore = store.db.prepare('SELECT count(*) AS n FROM hypothesis_nodes').get().n;
    const artifactsBefore = store.db.prepare('SELECT count(*) AS n FROM artifacts').get().n;
    assert.throws(() => store.checkpoint(c.id, 'Must reject unsafe state'), { status: 400 });
    await assert.rejects(call({ artifact_ids: [first.id] }), { status: 400 });
    await assert.rejects(store.upload(c.id, stageId, 'new.txt', 'text/plain', Buffer.from('clue')), { status: 400 });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hypothesis_nodes').get().n, nodesBefore);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM artifacts').get().n, artifactsBefore);
    assert.equal(store.caseRow(c.id).state, unsafeState);
    console.log(JSON.stringify({ evidence: 'passed', oversizedRefs: oversized.length, checks: 'early rejection, escaped/sparse/type variants, retry, order, missing/null evidence, active-stage membership, update, restore/select, legacy copy rejection' }));
  } finally { store.close(); }

  const bounded = new Store(resolve(`metadata-check-${randomUUID()}`));
  try {
    const c = bounded.createCase('Metadata limits'), stage = c.current_stage_id;
    const artifacts = Array.from({ length: 100 }, (_, i) => bounded.addArtifact(c.id, stage, `${i}.txt`, 'text/plain', Buffer.from('ABC')));
    const run = bounded.newRun(c.id, true), count = table => bounded.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const before = [count('requests'), count('events'), bounded.run(run.id).calls];
    for (const params of [{ padding: 'x'.repeat(32768) }, { artifact_id: artifacts[0].id, operation: 'caesar', params: { shift: 1, padding: '界'.repeat(12000) } }]) {
      await assert.rejects(bounded.call(c.id, run.id, randomUUID(), params.artifact_id ? 'transform_artifact' : 'get_case_state', params), { status: 413 });
      assert.deepEqual([count('requests'), count('events'), bounded.run(run.id).calls], before);
      assert.equal(bounded.caseRow(c.id).transforms, 0);
    }
    const exact = { padding: 'x'.repeat(32768 - Buffer.byteLength(JSON.stringify({ padding: '' }))) };
    assert.equal((await bounded.call(c.id, run.id, randomUUID(), 'get_case_state', exact)).status, 'ok');
    const unicode = await bounded.call(c.id, run.id, randomUUID(), 'record_hypothesis', { text: '界'.repeat(4000), status: 'untested', artifact_ids: artifacts.map(a => a.id), summary: '界'.repeat(240), next_step: '界'.repeat(120) });
    assert.equal(unicode.status, 'ok');
    const legacyParams = { padding: 'x'.repeat(128 * 1024) }, legacyId = randomUUID(), legacyResult = { status: 'ok', legacy: true };
    bounded.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(legacyId, c.id, run.id, hash(JSON.stringify({ caseId: c.id, runId: run.id, operation: 'get_case_state', params: legacyParams })), JSON.stringify(legacyResult));
    assert.deepEqual(await bounded.call(c.id, run.id, legacyId, 'get_case_state', legacyParams), legacyResult);
    const checkpoint = bounded.checkpoint(c.id, 'Legacy metadata'), savedParams = JSON.stringify(legacyParams);
    bounded.db.prepare('UPDATE artifacts SET params=? WHERE id=?').run(savedParams, artifacts[0].id);
    assert.throws(() => bounded.artifact(artifacts[0].id, c.id), { status: 413 });
    const stateBeforeRejection = bounded.caseRow(c.id).state;
    for (const [operation, params] of [['get_case_state', {}], ['restore_checkpoint', checkpoint]]) {
      const result = await bounded.call(c.id, run.id, randomUUID(), operation, params);
      assert.equal(result.status, 'failed'); assert.match(result.error, /32 KB/);
      assert(Buffer.byteLength(JSON.stringify(result)) < 1000);
      assert.equal(bounded.caseRow(c.id).state, stateBeforeRejection);
    }
    assert.equal(bounded.db.prepare('SELECT params FROM artifacts WHERE id=?').get(artifacts[0].id).params, savedParams);
    bounded.db.prepare('UPDATE artifacts SET params=? WHERE id=?').run('{}', artifacts[0].id);
    bounded.setSetting(`native_alias:${c.id}`, 'webapp:check'); queueNativeTask(bounded, run, 'Investigate');
    const first = claimNativeTask(bounded, {});
    for (let i = 0; i < 20; i++) assert.equal(claimNativeTask(bounded, {}).capability, first.capability);
    assert.equal(bounded.getCase(c.id).events.filter(e => e.operation === 'task_claim').length, 1);
    bounded.finishRun(run.id, 'replied');

    let release, entered;
    const preparing = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const row = { senderType: 1, senderId: 'owner', fingerprint: 'delayed-clue', createdAt: new Date(Date.now() + 1000).toISOString(), messageText: 'Attachment clue', attachments: [{}] };
    const client = { listConversations: async () => [{ alias: 'webapp:check', participants: [] }], getHistory: async () => [row] };
    const bridgeSource = readFileSync(new URL('../src/minds.js', import.meta.url), 'utf8');
    const start = runInNewContext(bridgeSource.slice(bridgeSource.indexOf('export function startNativeBridge')).replace('export function', 'function') + '\nstartNativeBridge;', {
      integrationStatus: () => ({ tools_ready: true, mind_id: 'mind' }), config: () => ({ MINDS_BUILDER_API_KEY: 'mock' }), sdk: () => client,
      parseHumanIdFromBuilderApiKey: () => 'owner', ownerNativeConversation: () => true, nativeSourceMessage, queueNativeTask, createHash, requireValue, AbortSignal,
      nativeSourceInput: async () => { entered(); await gate; return { source_text: 'Downloaded clue', files: [] }; },
      setInterval: () => 0, clearInterval() {}, console
    });
    const bridge = start(bounded);
    try {
      await preparing;
      const blocking = await bounded.exclusive(() => bounded.newRun(c.id));
      release(); await bridge.sync();
      assert.equal(bounded.setting('native_handled:delayed-clue'), undefined);
      assert.equal(bounded.setting('native_cursor:webapp:check'), undefined);
      assert.equal(bounded.listCases().length, 1);
      bounded.finishRun(blocking.id, 'replied');
      await bridge.sync();
      assert.equal(bounded.setting('native_handled:delayed-clue'), 'true');
      assert.equal(bounded.setting('native_cursor:webapp:check'), 'delayed-clue');
      assert.equal(bounded.listCases().length, 2);
      await bridge.sync(); assert.equal(bounded.listCases().length, 2);
    } finally { bridge.stop(); }
    console.log(JSON.stringify({ metadata: 'passed', checks: 'byte boundary, Unicode and 100 evidence IDs, early rejection, legacy replay and copy rejection, one claim per run, delayed native intake busy race', network: 'mocked' }));
  } finally { bounded.close(); }

  const specSource = readFileSync(new URL('./connection-spec.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '');
  for (const configured of ['custom-data', undefined]) {
    let opened;
    runInNewContext(specSource, { resolve, toolNames, mkdirSync() {}, writeFileSync() {}, readFileSync: () => 'Playbook', config: () => ({ RIDDLEMASTER_DATA_DIR: configured }), console: { log() {} }, Store: class {
      constructor(directory, options) { opened = { directory, options }; }
      setting() { return 'mock-token'; } close() {}
    } });
    assert.equal(opened.directory, configured || 'data'); assert.equal(opened.options.recover, false);
  }

  const directory = resolve(`security-http-${randomUUID()}`);
  mkdirSync(directory); cpSync(new URL('../public', import.meta.url), join(directory, 'public'), { recursive: true });
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], { cwd: directory, env: { ...process.env, PORT: String(port), RIDDLEMASTER_DATA_DIR: join(directory, 'data'), RIDDLEMASTER_NATIVE_BRIDGE: 'false', MINDS_BUILDER_API_KEY: '', MINDS_MIND_ID: '', RIDDLEMASTER_PUBLIC_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let logs = '', httpStore;
  child.stderr.on('data', chunk => { logs += chunk; });
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(logs); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Test server did not start')), 5000); timer.unref(); })]);
    httpStore = new Store(join(directory, 'data'), { recover: false });
    const c = httpStore.createCase('HTTP security'), artifact = await httpStore.upload(c.id, c.current_stage_id, 'clue.txt', 'text/plain', Buffer.from('ABC'));
    const other = httpStore.createCase('Other case'), run = httpStore.newRun(c.id, true), requestId = randomUUID();
    const token = runCapability(httpStore, c.id, run.id), origin = `http://127.0.0.1:${port}`;
    const input = { case_id: c.id, run_id: run.id, request_id: requestId, params: {} };
    const post = (value = input, auth = token) => fetch(origin + '/tools/get_case_state', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(value) });
    assert.equal((await post(input, 'invalid')).status, 401);
    assert.equal((await post({ ...input, case_id: other.id })).status, 401);
    assert.equal((await post({ ...input, case_id: other.id }, httpStore.setting('tool_token'))).status, 403);
    const saved = await httpStore.call(c.id, run.id, requestId, 'get_case_state', {});
    for (const status of ['running', 'replied', 'timed_out', 'interrupted']) {
      httpStore.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id);
      for (let i = 0; i < 4; i++) {
        const response = await post(); assert.equal(response.status, 200);
        const result = await response.json(); result.state.artifacts = result.state.artifacts.map(({ url, ...a }) => a);
        assert.deepEqual(result, JSON.parse(JSON.stringify(saved)));
      }
    }
    assert.equal(httpStore.getCase(c.id).events.filter(e => e.operation === 'tool_delivery' && e.request_id === requestId).length, 1);
    assert.equal(httpStore.run(run.id).calls, 1);
    assert.equal((await post({ ...input, params: { changed: true } })).status, 409);
    const next = httpStore.newRun(c.id, true), fresh = { ...input, run_id: next.id, request_id: randomUUID() }, nextToken = runCapability(httpStore, c.id, next.id);
    const eventsBefore = httpStore.getCase(c.id).events.length;
    assert.equal((await post({ ...fresh, params: { padding: 'x'.repeat(65536) } }, nextToken)).status, 413);
    assert.equal(httpStore.run(next.id).calls, 0); assert.equal(httpStore.getCase(c.id).events.length, eventsBefore);
    httpStore.db.prepare('UPDATE runs SET calls=30 WHERE id=?').run(next.id);
    for (let i = 0; i < 30; i++) assert.equal((await post({ ...fresh, request_id: randomUUID(), params: { padding: 'x'.repeat(16000) } }, nextToken)).status, 429);
    const blocked = httpStore.getCase(c.id).events.filter(e => e.run_id === next.id && e.result.status === 'blocked');
    assert.equal(blocked.length, 1); assert(Buffer.byteLength(JSON.stringify(blocked)) < 1000);
    assert.equal(httpStore.run(next.id).calls, 30);
    const page = await fetch(origin), cookie = page.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin + '/api/cases', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Rejected' }) })).status, 403);
    assert.equal((await fetch(`${origin}/media/${c.id}/${artifact.id}?token=${mediaToken(httpStore, c.id, artifact.id)}`)).status, 200);
    assert.equal((await fetch(`${origin}/media/${other.id}/${artifact.id}?token=${mediaToken(httpStore, c.id, artifact.id)}`)).status, 403);
    console.log(JSON.stringify({ http: 'passed', checks: 'capability case/run isolation, legacy first delivery, exact replay in four lifecycle states, conflict, early parameter bound, 30 quota refusals -> one bounded record, CSRF and media scope; configured Connection data path via stub', actual_mind: false }));
  } finally { child.kill(); await exited; httpStore?.close(); }
}
