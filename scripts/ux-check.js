import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { Store, hash } from '../src/store.js';
import { investigationUrl, nativeSourceMessage } from '../src/minds.js';

// Isolated persisted fixtures and the actual UI controller; no browser, external API or Mind request.
const store = new Store(resolve('work', `ux-check-${randomUUID()}`));
const call = (caseId, runId, operation, params = {}) => store.call(caseId, runId, randomUUID(), operation, params);
try {
  const png = await sharp({ create: { width: 12, height: 9, channels: 4, background: '#d9fa47' } }).png().toBuffer();
  const intake = await store.startInvestigation(randomUUID(), { source_text: 'RVZJREVOQ0U=', files: [{ name: 'clue.png', mime: 'image/png', content_base64: png.toString('base64') }] });
  const caseId = intake.case_id, stageId = intake.state.current_stage_id;
  const text = intake.state.artifacts.find(a => a.mime === 'text/plain'), image = intake.state.artifacts.find(a => a.mime === 'image/png');
  const initialRun = store.newRun(caseId);
  await call(caseId, initialRun.id, 'get_case_state');
  const decoded = await call(caseId, initialRun.id, 'transform_artifact', { artifact_id: text.id, operation: 'base64' });
  assert.equal(decoded.text, 'EVIDENCE');
  const observation = await call(caseId, initialRun.id, 'record_hypothesis', { text: 'Observation: text is a Base64 string.', status: 'supported', kind: 'observation', summary: 'The source contains encoded text.', artifact_ids: [text.id] });
  const primary = await call(caseId, initialRun.id, 'record_hypothesis', { text: 'Hypothesis: decoding the source produces the answer.', status: 'supported', kind: 'hypothesis', summary: 'Base64 decoding produced EVIDENCE.', next_step: 'Decode the original text', artifact_ids: [text.id, decoded.artifact.id] });
  const hypothesis = primary.hypothesis;
  for (let i = 0; i < 4; i++) await call(caseId, initialRun.id, 'record_hypothesis', { text: `Hypothesis: inspect channel ${i}.`, status: 'untested', next_step: `Inspect image channel ${i}`, summary: 'Check whether the image contains another clue.', artifact_ids: [image.id] });
  const saved = store.getCase(caseId).hypothesis_tree.find(h => h.id === hypothesis.id);
  assert.equal(saved.next_step, hypothesis.next_step);
  const invalid = await call(caseId, initialRun.id, 'record_hypothesis', { hypothesis_id: hypothesis.id, text: hypothesis.text, status: 'supported', summary: 'x'.repeat(241) });
  assert.equal(invalid.status, 'failed');
  assert.equal(store.getCase(caseId).hypothesis_tree.find(h => h.id === hypothesis.id).summary, hypothesis.summary);
  const initialCheck = await call(caseId, initialRun.id, 'check_candidate', { candidate: decoded.text, explanation: 'The source decodes directly to EVIDENCE.' });
  assert.equal(initialCheck.verification, 'unverified');
  assert.equal(initialCheck.explanation, 'The source decodes directly to EVIDENCE.');
  store.finishRun(initialRun.id, 'replied');

  const html = readFileSync('public/index.html', 'utf8'), js = readFileSync('public/app.js', 'utf8');
  assert(!/<form\b|type="file"/.test(html));
  assert(!/File details|Investigation details|Run and limits|Journal|Mind replies|id="connection"|id="progress-actions"/.test(html));
  assert(html.indexOf('id="next-steps"') < html.indexOf('id="case-materials"'), 'Mobile keyboard order must put checks before evidence');
  const nodes = new Set();
  const connect = (n, value) => { n.isConnected = value; n.children.forEach(child => connect(child, value)); };
  function node(tag = 'div', connected = false) {
    const n = { tag, dataset: {}, children: [], textContent: '', isConnected: connected, scrollTop: 0, open: false,
      append(...children) { this.children.push(...children); children.forEach(child => connect(child, this.isConnected)); },
      replaceChildren(...children) { this.children.forEach(child => connect(child, false)); this.children = []; this.append(...children); },
      setAttribute(name, value) { this[name] = value; },
      focus() {}, scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; this.onclose?.(); }
    }; nodes.add(n); return n;
  }
  const ids = new Map([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => [m[1], node('div', true)]));
  for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) assert(ids.has(m[1]), `Missing UI element: ${m[1]}`);
  function query(selector) {
    return [...nodes].filter(n => n.isConnected && (selector === '[data-check-hypothesis]' ? n.dataset.checkHypothesis : selector === '[data-mind-link]' ? n === ids.get('resume-mind') : selector === 'details[data-hypothesis][open]' ? n.tag === 'details' && n.dataset.hypothesis && n.open : false));
  }
  const content = n => [n.textContent, ...n.children.map(content)].join(' ');
  let branchRequests = 0, releaseStart;
  const response = value => ({ ok: true, json: async () => JSON.parse(JSON.stringify(value)), text: async () => value });
  const context = {
    document: { getElementById: id => ids.get(id), createElement: tag => node(tag), querySelectorAll: query, activeElement: null, body: node('body', true) },
    URL, crypto: { randomUUID }, matchMedia: () => ({ matches: true }), setInterval() {},
    fetch: async (path, options = {}) => {
      if (path === '/api/status') return response({ tools_ready: true, mind_id: 'test-mind' });
      if (path === '/api/cases') return response(store.listCases());
      if (path.endsWith('/check-hypothesis')) {
        branchRequests++;
        store.selectHypothesis(caseId, JSON.parse(options.body).hypothesis_id);
        const run = store.newRun(caseId);
        return new Promise(resolve => { releaseStart = () => resolve(response(run)); });
      }
      if (path.startsWith('/api/cases/')) {
        const c = store.getCase(path.split('/')[3]); c.artifacts.forEach(a => { a.url = `/media-test/${a.id}`; }); return response(c);
      }
      if (path.startsWith('/media-test/')) return response(store.file(path.split('/')[2]).toString());
      throw new Error(`Unexpected UI request: ${path}`);
    }
  };
  async function openUi(href) {
    for (const m of html.matchAll(/<[^>]+\bid="([\w-]+)"[^>]*>/g)) ids.get(m[1]).hidden = /\bhidden\b/.test(m[0]);
    context.window = { location: { href }, history: { replaceState(_state, _title, url) { context.window.location.href = url; } } };
    return runInNewContext(`(async () => { ${js}; return {refresh,loadCase,checkHypothesis,hypothesisCopy,caseTitle}; })()`, context);
  }
  const link = new URL(investigationUrl(caseId));
  assert.equal(link.hostname, '127.0.0.1');
  assert.equal(link.searchParams.get('case'), caseId);
  assert.deepEqual([...link.searchParams.keys()], ['case'], 'The viewer link must not contain credentials');
  const ui = await openUi(link.href);
  assert.equal(ids.get('case-title').textContent, intake.state.title);
  assert.equal(ui.caseTitle('No oracle / browser acceptance'), 'Saved clue');
  assert.equal(ui.caseTitle('Hidden signal / B'), 'Hidden signal / B');
  const oldCopy = ui.hypothesisCopy({ text: 'Alternate interpretation (untested): missing digit = 4 via constant row sums. Observed rows: 4+8+4=16.', summary: "Branch eb4bc931: check_candidate '4' returned unverified (no oracle, attempts 2/3); row-sum reading stays consistent.", next_step: 'Steward selects branch ?=4 vs ?=6, or a stage oracle is configured to separate them.' });
  assert.equal(oldCopy.summary, 'Missing digit = 4 via constant row sums.');
  assert.equal(oldCopy.nextStep, 'Check this interpretation');
  assert.equal(ui.hypothesisCopy(hypothesis).nextStep, hypothesis.next_step);
  assert.equal(ui.hypothesisCopy(hypothesis).summary, hypothesis.summary);
  assert.equal(ui.hypothesisCopy({ text: 'Hypothesis: BLUE_KEY is written on the clue.' }).summary, 'BLUE_KEY is written on the clue.');
  assert(!/check_candidate|eb4bc931|Steward|oracle/.test(Object.values(oldCopy).join(' ')));
  assert.equal(ui.hypothesisCopy({ text: 'Hypothesis: the title itself says check_candidate is the clue.', summary: 'API request returned status 422.' }).summary, 'Saved hypothesis');
  assert.equal(ui.hypothesisCopy({ text: 'HTTP_Execute result on branch ec5ac3cb.', summary: 'Re-fetched clue bytes confirm S+O+L = SOL; candidate check returned unverified (no oracle on this stage).' }).summary, 'The clue suggests S+O+L = SOL');
  assert.equal(ui.hypothesisCopy({ text: 'Hypothesis: the letters spell BOW.', next_step: 'Check the candidate BOW against the answer checker.' }).nextStep, 'Check answer BOW');
  assert.equal(ui.hypothesisCopy({ text: 'Hypothesis: the missing digit is 8.', next_step: 'Check the candidate 8 against the answer checker.' }).nextStep, 'Check answer 8');
  const bowCopy = ui.hypothesisCopy({ summary: 'Brave, Owls and Wave start with B, O and W, spelling BOW; the answer check gave no confirmation.', next_step: 'Recheck BOW if an answer checker becomes available.' });
  assert.equal(bowCopy.summary, 'Brave, Owls and Wave start with B, O and W, spelling BOW');
  assert.equal(bowCopy.nextStep, 'Check this interpretation');
  assert.equal(ids.get('preview').children[0].children[0].tag, 'img', 'An image must open before its accompanying text');
  assert.equal(ids.get('finding-reason').textContent, initialCheck.explanation);
  assert.equal(ids.get('finding').dataset.verification, 'unverified');
  assert.equal(ids.get('case-library').open, false);
  assert.equal(ids.get('hypotheses').children[0].children.length, 3);
  assert(!content(ids.get('hypotheses')).includes(observation.hypothesis.summary));
  const imageButton = ids.get('preview').children[0];
  await imageButton.onclick(); assert.equal(ids.get('image-zoom').open, true);
  assert.equal(ids.get('zoom-content').children[0].src, `/media-test/${image.id}`);
  ids.get('close-image').onclick(); assert.equal(ids.get('image-zoom').open, false);
  assert.equal(ids.get('zoom-content').children.length, 0);

  const starting = ui.checkHypothesis(hypothesis);
  await ui.checkHypothesis(hypothesis); assert.equal(branchRequests, 1, 'Duplicate clicks must not start another branch');
  releaseStart(); await starting;
  let card = ids.get('hypotheses').children[0].children[0];
  assert.equal(card.dataset.checkStatus, 'checking');
  assert(content(card).includes(hypothesis.next_step));
  assert(query('[data-check-hypothesis]').every(b => b.disabled));
  const runId = store.getCase(caseId).runs[0].id;
  await call(caseId, runId, 'get_case_state');
  await call(caseId, runId, 'check_candidate', { candidate: 'EVIDENCE', explanation: 'The selected source decodes to EVIDENCE.' });
  await call(caseId, runId, 'record_hypothesis', { hypothesis_id: hypothesis.id, text: hypothesis.text, status: 'supported', artifact_ids: hypothesis.artifact_ids });
  store.finishRun(runId, 'replied'); await ui.refresh();
  card = ids.get('hypotheses').children[0].children[0];
  assert.equal(card.dataset.checkStatus, 'unverified');
  assert(content(card).includes('Answer: EVIDENCE'));
  assert.equal(ids.get('finding-reason').textContent, 'The selected source decodes to EVIDENCE.');
  assert.equal(ids.get('run-state').textContent, 'Choose an idea to check.');
  assert(!content(ids.get('hypotheses')).includes(hypothesis.text), 'Raw diagnostic reasoning must stay out of player cards');
  assert(![...nodes].some(n => n.isConnected && n.tag === 'time'), 'No timestamps in the player surface');
  assert(!query('[data-check-hypothesis]').every(b => b.disabled));
  assert.equal(store.getCase(caseId).hypothesis_tree.find(h => h.id === hypothesis.id).next_step, hypothesis.next_step);

  const failedRun = store.newRun(caseId);
  store.finishRun(failedRun.id, 'failed', 'Image could not be read. Bearer secret'); await ui.refresh();
  assert.equal(ids.get('run-detail').hidden, false); assert.equal(ids.get('resume-mind').hidden, false);
  assert(!ids.get('run-detail').textContent.includes('secret'));
  assert.equal(ids.get('hypotheses').children[0].children[0].dataset.checkStatus, 'blocked');
  const confirmedRun = store.newRun(caseId);
  store.db.prepare('INSERT INTO oracle VALUES(?,?,?)').run(caseId, stageId, hash('EVIDENCE'));
  await call(caseId, confirmedRun.id, 'check_candidate', { candidate: 'EVIDENCE', explanation: 'The independent fixture validator matched the decoded text.' });
  store.finishRun(confirmedRun.id, 'replied'); await ui.refresh();
  assert.equal(ids.get('finding').dataset.verification, 'confirmed');
  assert.equal(ids.get('hypotheses').children[0].children[0].dataset.checkStatus, 'confirmed');
  assert(query('[data-check-hypothesis]').every(b => b.disabled));
  assert.equal(store.getCase(caseId).attempts[0].used, 3);
  const otherStage = store.addStage(caseId, 'Next clue');
  const otherIdea = await store.call(caseId, null, randomUUID(), 'record_hypothesis', { text: 'Hypothesis: inspect the next clue.', status: 'untested', kind: 'hypothesis', summary: 'The next clue may use the same pattern.', next_step: 'Inspect the next clue' });
  store.selectStage(caseId, stageId); await ui.refresh();
  assert(query('[data-check-hypothesis]').some(b => b.dataset.checkHypothesis === otherIdea.hypothesis.id && !b.disabled), 'Exhausted checks on one stage must not block another stage');
  assert.equal(store.getCase(caseId).stages.find(s => s.id === otherStage.id).status, 'open');

  const incoming = await store.startInvestigation(randomUUID(), { source_text: 'A new clue' }); await ui.refresh();
  assert.equal(ids.get('case-title').textContent, intake.state.title, 'A new source must not replace the linked puzzle');
  await ui.loadCase(incoming.case_id);
  assert.equal(new URL(context.window.location.href).searchParams.get('case'), incoming.case_id);
  assert.equal(ids.get('preview').children[0].tag, 'pre');
  await ui.loadCase(caseId); await ui.refresh(); assert.equal(ids.get('case-title').textContent, intake.state.title);
  await openUi(context.window.location.href);
  assert.equal(ids.get('case-title').textContent, intake.state.title, 'Reload must preserve the chosen puzzle instead of showing the newest one');
  const root = await openUi('http://127.0.0.1:4317/');
  assert.equal(ids.get('case-title').textContent, incoming.state.title, 'The unlinked homepage must still follow the latest source');
  const newer = await store.startInvestigation(randomUUID(), { source_text: 'Another incoming clue' }); await root.refresh();
  assert.equal(ids.get('case-title').textContent, newer.state.title);
  await root.loadCase(caseId);
  await store.startInvestigation(randomUUID(), { source_text: 'Do not replace the selected puzzle' }); await root.refresh();
  assert.equal(ids.get('case-title').textContent, intake.state.title);
  await openUi(investigationUrl(randomUUID()));
  assert(content(ids.get('notice')).includes('This investigation is unavailable'));
  assert.equal(ids.get('case-library').open, true);
  assert(content(ids.get('cases')).includes(incoming.state.title));
  assert.notEqual(ids.get('empty').hidden, true, 'A missing link must not show an unrelated investigation');

  const nativeHuman = randomUUID();
  assert.equal(nativeSourceMessage({ senderType: 1, senderId: nativeHuman, fingerprint: 'control', messageText: 'Instruction: Continue the saved investigation.', attachments: [{ content: 'private brief' }] }, nativeHuman), null, 'A control attachment must not become another puzzle');
  console.log(JSON.stringify({ status: 'passed', checks: 'minimal player surface, hidden diagnostics/timestamps, preserved candidate truth and branch actions, control attachment intake isolation, existing source navigation and budget behavior', rendered_browser: false, actual_mind: false }));
} finally { store.close(); }
