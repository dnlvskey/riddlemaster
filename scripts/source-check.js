import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { Store, hash } from '../src/store.js';
import { sourceInput, readInput } from '../src/source.js';
import { nativeSourceMessage, nativeSourceInput } from '../src/minds.js';

const directory = resolve('work', `source-check-${randomUUID()}`), store = new Store(directory);
const clue = '  Puzzle <A> · café\n  RVZJREVOQ0U=\n';
const file = (name, mime, bytes) => ({ name, mime, content_base64: bytes.toString('base64') });
const image = sharp({ create: { width: 12, height: 9, channels: 4, background: '#d9fa47' } });
const images = await Promise.all(['png','jpeg','webp'].map(format => image.clone().toFormat(format).toBuffer()));
try {
  const request = randomUUID(), result = await store.startInvestigation(request, { source_text: clue });
  assert.equal(result.status, 'ok');
  assert.equal(result.state.source.kind, 'text');
  assert.equal(store.file(result.state.artifacts[0].id).toString(), clue);
  assert.deepEqual(await store.startInvestigation(request, { source_text: clue }), JSON.parse(JSON.stringify(result)));
  await assert.rejects(store.startInvestigation(request, { source_text: clue + 'changed' }), { status: 409 });
  for (const [index, mime] of ['image/png','image/jpeg','image/webp'].entries()) {
    const bytes = images[index], input = { files: [file(`clue.${mime.split('/')[1]}`, mime, bytes)] };
    const received = await store.startInvestigation(randomUUID(), input, true);
    assert.equal(received.status, 'ok');
    assert.equal(received.state.source.kind, 'file');
    assert.equal(received.state.artifacts[0].mime, 'image/png');
    const c = store.getCase(received.case_id), original = c.artifacts.find(a => a.mime === mime);
    assert.deepEqual(store.file(original.id), bytes);
    assert.equal(original.name, input.files[0].name);
    if (mime !== 'image/png') assert.equal(received.state.artifacts[0].parent_id, original.id);
    const transformed = await store.call(c.id, received.run_id, randomUUID(), 'transform_artifact', { artifact_id: received.state.artifacts[0].id, operation: 'invert' });
    assert.equal(transformed.status, 'ok');
    assert.equal(store.getCase(c.id).budgets.transforms_used, 1);
    store.finishRun(received.run_id, 'replied');
  }
  const textFile = await readInput({ files: [file('../clue.txt', 'text/plain', Buffer.from(clue))] });
  assert.equal(textFile.files[0].name, '.._clue.txt');
  assert.equal(textFile.files[0].bytes.toString(), clue);
  assert.throws(() => sourceInput({ source_text: ' ' }));
  assert.throws(() => sourceInput({ files: [file('file.pdf', 'application/pdf', Buffer.from('x'))] }));
  assert.throws(() => sourceInput({ files: [{ name: 'x.png', mime: 'image/png', content_base64: 'invalid!' }] }));
  assert.throws(() => sourceInput({ source_url: 'https://127.0.0.1/' }));
  await assert.rejects(readInput({ files: [file('false.png', 'image/png', images[1])] }));
  const owner = { senderType: 1, senderId: 'owner', fingerprint: 'test', messageText: clue };
  assert.equal((await nativeSourceInput(nativeSourceMessage(owner, 'owner'))).source_text, clue);
  assert.equal(nativeSourceMessage(owner, 'someone-else'), null);
  assert.equal(nativeSourceMessage({ ...owner, messageText: 'https://example.com/a https://example.com/b' }, 'owner').text, 'https://example.com/a https://example.com/b');
  for (const text of ['continue', 'ok', 'Instruction: check the answer', 'Check the branch 2', 'Check the selected idea. [Open investigation](http://127.0.0.1:4317/?case=abc)', 'RIDDLEMASTER_BACKEND run']) assert.equal(nativeSourceMessage({ ...owner, messageText: text }, 'owner'), null);
  for (const payload of ['artifact','content']) {
    const message = nativeSourceMessage({ ...owner, attachments: [{ fileName: 'clue.jpg', mimeType: 'image/jpeg', [payload]: images[1].toString('base64') }] }, 'owner');
    assert.equal((await readInput(await nativeSourceInput(message))).files.at(-1).original_sha256, hash(images[1]));
  }
  await assert.rejects(nativeSourceInput({ text: 'image clue', attachments: [{ artifactId: 'metadata-only', mimeType: 'image/png' }] }), /no downloadable URL or file bytes/);
} finally { store.close(); }

// Use a separate working directory without .env: this checks real HTTP intake without sending a Mind request.
cpSync(resolve('public'), join(directory, 'public'), { recursive: true });
const child = spawn(process.execPath, [resolve('src/server.js')], { cwd: directory, env: { ...process.env, PORT: '4318', RIDDLEMASTER_DATA_DIR: join(directory, 'http-data'), RIDDLEMASTER_NATIVE_BRIDGE: 'false', MINDS_BUILDER_API_KEY: '', MINDS_MIND_ID: '', RIDDLEMASTER_PUBLIC_URL: '' }, stdio: ['ignore','pipe','pipe'] });
let logs = '';
child.stderr.on('data', chunk => { logs += chunk; });
const childExited = once(child, 'exit');
try {
  await Promise.race([once(child.stdout, 'data'), childExited.then(() => { throw new Error(logs); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Test server did not start')), 5000); timer.unref(); })]);
  const origin = 'http://127.0.0.1:4318', page = await fetch(origin), cookie = page.headers.get('set-cookie').split(';')[0];
  const html = await page.text();
  assert(!/<form\b|type="file"/.test(html), 'The web workspace must not duplicate native intake/chat');
  assert(html.includes('data-mind-link'));
  const post = async (path, input) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify(input) });
    const result = await response.json(); assert(response.ok, result.error); return result;
  };
  let firstCase, lastImportedCase;
  for (const input of [{ source_text: clue }, { files: [file('clue.jpg','image/jpeg',images[1])] }, { source_url: 'https://example.com/' }]) {
    const result = await post('/api/source', { ...input, request_id: randomUUID() });
    assert.equal(result.status, 'ok'); assert.equal(result.mind_pending, true);
    const c = await (await fetch(origin + `/api/cases/${result.case_id}`, { headers: { Cookie: cookie } })).json();
    firstCase ??= c;
    lastImportedCase = c;
    assert(c.source.complete); assert.equal(c.runs.length, 0);
    if (input.source_text) assert.equal(await (await fetch(origin + c.artifacts[0].url)).text(), clue);
    if (input.source_url) assert.equal(c.title, 'Example Domain');
    if (input.files) {
      const original = c.artifacts.find(a => a.mime === 'image/jpeg');
      assert.deepEqual(Buffer.from(await (await fetch(origin + original.url)).arrayBuffer()), images[1]);
      const uploaded = await post(`/api/cases/${c.id}/upload`, { stage_id: c.current_stage_id, ...file('next.webp','image/webp',images[2]) });
      assert.equal(uploaded.mime, 'image/png');
    }
  }
  const node = () => ({ dataset: {}, scrollTop: 0, isConnected: true, append() {}, replaceChildren(...children) { this.children = children; }, setAttribute(name, value) { this[name] = value; }, focus() {} });
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => [m[1], node()]));
  const js = readFileSync('public/app.js', 'utf8');
  for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) assert(ids.has(m[1]), `Missing UI control ${m[1]}`);
  const browserLocation = { href: origin };
  const ui = await runInNewContext(`(async () => { ${js}; return {refresh,loadCase}; })()`, {
    document: { getElementById: id => ids.get(id), createElement: node, querySelectorAll: () => [], activeElement: null, body: node() },
    URL, matchMedia: () => ({matches:false}), setInterval() {},
    window: { location: browserLocation, history: { replaceState(_state, _title, url) { browserLocation.href = url; } } },
    fetch: (path, options = {}) => fetch(origin + path, { ...options, headers: { ...options.headers, Cookie:cookie, Origin:origin } })
  });
  const selectedCase = () => ids.get('cases').children.find(child => child['aria-current'] === 'true')?.dataset.focusKey;
  assert.equal(ids.get('case-title').textContent, lastImportedCase.title, 'Opening the workspace must show the newest investigation');
  assert.equal(selectedCase(), `case:${lastImportedCase.id}`);
  const incoming = await post('/api/source', { source_text: 'Fresh native clue', request_id:randomUUID() });
  await ui.refresh();
  assert.equal(ids.get('case-title').textContent, incoming.state.title, 'A new incoming case must appear automatically');
  assert.equal(selectedCase(), `case:${incoming.case_id}`);
  assert.equal(ids.get('case-content').hidden, false);
  await ui.loadCase(firstCase.id); await ui.refresh();
  assert.equal(ids.get('case-title').textContent, firstCase.title, 'Choosing history must remain stable');
  assert.equal(selectedCase(), `case:${firstCase.id}`);
  assert.equal(new URL(browserLocation.href).searchParams.get('case'), firstCase.id);
  const downloaded = await nativeSourceInput({ text: '', attachments: [{ url: 'https://www.w3.org/Icons/w3c_home.png', fileName: 'web-clue.png', mimeType: 'image/png' }] });
  assert.equal((await readInput(downloaded)).files[0].mime, 'image/png');
  console.log(JSON.stringify({ status: 'passed', checks: 'text/image originals, derived tools, retries, validation, native payloads, actual HTTP text/JPEG/website/upload, remote PNG attachment, web-only viewing/automatic case follow/history selection', rendered_browser: false, actual_mind: false }));
} finally { child.kill(); await childExited; }
