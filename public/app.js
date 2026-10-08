const $ = id => document.getElementById(id);
let current = null, selectedArtifact = null, integration = null, previewKey = null, pendingHypothesis = null, latestCaseId = null;
const linkedCaseId = new URL(window.location.href).searchParams.get('case');
let followLatest = linkedCaseId === null;

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401 && window.location.pathname === '/workspace') window.location.assign('/?case=' + encodeURIComponent(current?.id || linkedCaseId || ''));
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function safely(work) { return async event => { event?.preventDefault(); notice(''); try { await work(event); } catch (error) { notice(playerError(error.message)); } }; }
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls) { const b = el('button', text, cls); b.type = 'button'; b.onclick = safely(action); return b; }
function busy() { return current?.runs.some(run => run.status === 'running'); }
function stage() { return current?.stages.find(s => s.id === current.current_stage_id); }
function target(action) { return `/api/cases/${current.id}/${action}`; }
async function loadCase(caseId) {
  const selected = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  if ($('image-zoom').open) $('image-zoom').close();
  current = selected;
  followLatest = false;
  const url = new URL(window.location.href);
  url.searchParams.set('case', current.id);
  window.history.replaceState(null, '', url.href);
  selectedArtifact = null; previewKey = null;
  if (matchMedia('(max-width: 960px)').matches) $('case-library').open = false;
  await refresh();
}
function materialName(a) {
  if (a.operation === 'png_channel') return 'Image detail';
  if (['invert', 'contrast'].includes(a.operation)) return 'Adjusted image';
  if (['xor', 'base64', 'hex', 'caesar', 'morse'].includes(a.operation)) return 'Decoded text';
  if (a.operation === 'import_text') return 'Source text';
  if (a.operation === 'import_image') return a.parent_id ? 'Clue image' : 'Original image';
  if (a.operation === 'upload' && a.mime.startsWith('image/')) return 'Original image';
  return a.name;
}
function caseTitle(title) { return technicalCopy(title) ? 'Saved clue' : title; }
function hypothesisSummary(text) {
  const hypothesis = /(?:^|\s)(?:Primary hypothesis|Alternate interpretation|Alternate hypothesis|Hypothesis|Observation|\u0413\u0438\u043f\u043e\u0442\u0435\u0437\u0430|\u041d\u0430\u0431\u043b\u044e\u0434\u0435\u043d\u0438\u0435)(?:\s*\([^)]*\))?:\s*/i.exec(text);
  const lines = (hypothesis ? text.slice(hypothesis.index + hypothesis[0].length) : text).replace(/\*\*|`/g, '').replace(/\b(?:artifact|stage|run|branch)\s+[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi, '').replace(/\(sha-?256\s+[0-9a-f]{64}\)/gi, '').replace(/[ \t]{2,}/g, ' ').split(/\n|(?<=\.)\s+/);
  const line = lines.find(s => s.trim() && !/[0-9a-f]{8}-[0-9a-f]{4}-|artifact_id|parent_id|stage_id|sha-?256/i.test(s))?.trim() || 'Saved hypothesis';
  return line.length > 180 ? line.slice(0, 177).trimEnd() + '…' : line;
}
function technicalCopy(text) {
  return /\b(?:get_case_state|check_candidate|record_hypothesis|transform_artifact|save_checkpoint|restore_checkpoint|finish_investigation|HTTP_Execute|IMAGE_Analyze|(?:case|run|stage|branch|artifact|hypothesis|parent|request)_ids?|SDK|API|SHA-?256|steward|oracle|no_oracle|validator|unverified|budget|attempts)\b|\b(?:candidate check|tool calls|check returned|no answer check|answer checker|answer check (?:gave|returned))\b|\b(?:branch|stage|run|artifact|hypothesis|checkpoint)\s+[0-9a-f]{8}\b|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text || '');
}
function playerSentence(text) {
  const plain = String(text || '').split(/;\s*|\n|(?<=\.)\s+/).filter(part => !technicalCopy(part)).join(' ');
  const sentence = hypothesisSummary(plain).replace(/\bRe-fetched clue bytes confirm\b/gi, 'The clue suggests');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
function hypothesisCopy(h) {
  const summary = playerSentence(h.summary && !technicalCopy(h.summary.split(';')[0]) ? h.summary : h.text);
  const action = String(h.next_step || '').trim().replace(/^Check the candidate (.{1,40}) against the answer checker\.?$/i, 'Check answer $1');
  const nextStep = action && action.length <= 80 && !technicalCopy(action) && !/\b(?:oracle|configure|configured)\b|\b(?:select|choose)\b.*\bbranch\b/i.test(action) ? action : 'Check this interpretation';
  return { summary: technicalCopy(summary) ? 'This interpretation needs a closer look.' : summary, nextStep };
}
function nextHypotheses(nodes, stageId) {
  const available = nodes.filter(h => h.stage_id === stageId && !isObservation(h) && (h.status !== 'rejected' || h.id === current.selected_hypothesis_id));
  const parents = new Set(available.map(h => h.parent_id));
  return available.sort((a, b) => Number(b.id === current.selected_hypothesis_id) - Number(a.id === current.selected_hypothesis_id) || Number(a.status !== 'untested') - Number(b.status !== 'untested') || Number(parents.has(a.id)) - Number(parents.has(b.id))).slice(0, 3);
}
function isObservation(h) {
  return h.kind ? h.kind === 'observation' : /^\s*(?:\*\*)?(?:Observation|Observed|\u041d\u0430\u0431\u043b\u044e\u0434\u0435\u043d\u0438\u0435)(?:\s*\([^)]*\))?:/i.test(h.text);
}
function defaultArtifact(artifacts) {
  return artifacts.find(a => a.mime.startsWith('image/') && a.operation === 'import_image') || artifacts.find(a => a.mime.startsWith('image/')) || artifacts.find(a => a.operation === 'import_text') || artifacts[0];
}
function playerError(error) {
  if (/This investigation is unavailable/.test(error)) return 'This investigation is unavailable. Choose a saved case or send a new clue in Mind.';
  if (/budget exhausted|limit reached/i.test(error)) return 'No more checks are available for this clue. Continue in Mind.';
  if (/wait for|already.*running/i.test(error)) return 'Mind is still checking. Try again when it finishes.';
  if (/material could not be loaded|image could not be read/i.test(error)) return 'This clue could not be opened. Try it again or resend it in Mind.';
  return 'This check could not finish. Your clues are saved; continue in Mind.';
}
function hypothesisChecks(h) {
  return current.events.filter(e => e.stage_id === h.stage_id && e.params._context?.hypothesis_id === h.id && ['transform_artifact', 'check_candidate'].includes(e.operation));
}
function cardState(h, running) {
  const selected = current.selected_hypothesis_id === h.id;
  const checks = hypothesisChecks(h);
  const lastRunId = selected ? current.runs[0]?.id : checks.at(-1)?.run_id;
  const check = [...checks].reverse().find(e => e.operation === 'check_candidate' && e.run_id === lastRunId);
  if (selected && running) return { status: 'checking', label: 'Checking this version…' };
  if (selected && ['failed', 'timed_out', 'interrupted'].includes(current.runs[0]?.status)) return { status: 'blocked', label: 'Check stopped', outcome: 'Try this idea again or continue in Mind.' };
  if (check?.result.verification) {
    const status = check.result.verification;
    return { status, label: { confirmed: 'Answer confirmed', unverified: 'Possible answer', incorrect: 'Answer did not match' }[status] || 'Checked', outcome: `Answer: ${check.result.candidate}` };
  }
  if (check && check.result.status !== 'ok') return { status: 'blocked', label: 'Check stopped', outcome: playerError(check.result.error) };
  return { status: h.status, label: { untested: 'Not checked', supported: 'Looks promising', rejected: 'Ruled out' }[h.status] || 'Saved idea' };
}
function actionName(e) {
  const names = { get_case_state: 'Reading the clue…', record_hypothesis: 'Exploring an idea…', check_candidate: 'Checking an answer…', save_checkpoint: 'Saving progress…', restore_checkpoint: 'Returning to an idea…' };
  if (e.operation !== 'transform_artifact') return names[e.operation];
  return ['png_channel', 'invert', 'contrast'].includes(e.params.operation) ? 'Inspecting the image…' : 'Decoding the clue…';
}
async function checkHypothesis(h) {
  if (busy() || pendingHypothesis) return;
  pendingHypothesis = h.id;
  for (const b of document.querySelectorAll('[data-check-hypothesis]')) { b.disabled = true; if (b.dataset.checkHypothesis === h.id) b.textContent = 'Starting…'; }
  $('run-state').textContent = 'Starting Mind…'; $('run-state').dataset.status = 'starting';
  try { await api(target('check-hypothesis'), { hypothesis_id: h.id, request_id: crypto.randomUUID() }); selectedArtifact = null; }
  finally { pendingHypothesis = null; await refresh(); }
}

async function refresh() {
  integration = await api('/api/status');
  const connected = integration.tools_ready;
  const mindUrl = new URL('https://app.hellominds.ai/');
  if (integration.mind_id) mindUrl.searchParams.set('mindId', integration.mind_id);
  for (const link of document.querySelectorAll('[data-mind-link]')) link.href = mindUrl.href;

  const cases = await api('/api/cases');
  if (followLatest && cases.length && (!current || latestCaseId && latestCaseId !== cases[0].id)) {
    if ($('image-zoom').open) $('image-zoom').close();
    current = await api(`/api/cases/${cases[0].id}`);
    selectedArtifact = null; previewKey = null;
  }
  else if (current) current = await api(`/api/cases/${current.id}`);
  latestCaseId = cases[0]?.id || null;
  const focused = document.activeElement, focusKey = focused?.dataset.focusKey;
  function restoreFocus() {
    if (focusKey && !focused.isConnected && document.activeElement === document.body) (document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) || $('run-state')).focus({ preventScroll: true });
  }
  try {
  const caseScroll = $('cases').scrollTop;
  $('cases').replaceChildren(...cases.map(c => {
    const b = button(caseTitle(c.title), () => loadCase(c.id), current?.id === c.id ? 'selected' : '');
    b.dataset.focusKey = `case:${c.id}`;
    if (current?.id === c.id) b.setAttribute('aria-current', 'true');
    return b;
  }));
  $('cases').scrollTop = caseScroll;
  if (!current) return;
  const active = stage(), running = Boolean(busy() || pendingHypothesis);
  $('case-title').textContent = caseTitle(current.title);
  $('source-info').hidden = !current.source || !current.source.url && current.source.complete;
  if (current.source) {
    if (current.source.url) {
      const link = el('a', 'Source'); link.href = current.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      $('source-info').replaceChildren(link);
    } else $('source-info').replaceChildren(el('span', current.source.kind === 'file' ? 'Uploaded clue' : 'Text clue'));
    if (!current.source.complete) $('source-info').append(el('p', 'Part of the clue is missing. Send the missing material in Mind.'));
  }
  $('empty').hidden = true; $('case-content').hidden = false; $('case-materials').hidden = false; $('next-steps').hidden = false;
  $('stages').hidden = current.stages.length < 2;
  $('stages').replaceChildren(...current.stages.map((s, i) => {
    const b = button(`${i + 1}. ${s.title}`, async () => { await api(target('select-stage'), { stage_id: s.id }); selectedArtifact = null; await refresh(); }, s.id === active.id ? 'selected' : '');
    b.dataset.focusKey = `stage:${s.id}`;
    b.disabled = running; b.title = s.status.replaceAll('_', ' ');
    if (s.id === active.id) b.setAttribute('aria-current', 'step');
    return b;
  }));

  const artifacts = current.artifacts.filter(a => active.artifact_ids.includes(a.id));
  if (!current.artifacts.some(a => a.id === selectedArtifact)) selectedArtifact = defaultArtifact(artifacts)?.id || null;
  $('artifacts').replaceChildren(...artifacts.map(a => {
    const b = button(materialName(a), async () => { selectedArtifact = a.id; await refresh(); }, selectedArtifact === a.id ? 'selected' : '');
    b.dataset.focusKey = `artifact:${a.id}`;
    b.title = a.name; b.setAttribute('aria-pressed', String(selectedArtifact === a.id)); return b;
  }));
  const artifact = current.artifacts.find(a => a.id === selectedArtifact);
  if (artifact?.id !== previewKey) {
    if (!artifact) $('preview').replaceChildren(el('p', 'No material yet.', 'quiet'));
    else if (artifact.mime.startsWith('image/')) {
      const img = el('img'); img.src = artifact.url; img.alt = artifact.name;
      const view = button(null, () => {
        const enlarged = el('img'); enlarged.src = artifact.url; enlarged.alt = artifact.name;
        $('zoom-title').textContent = materialName(artifact); $('zoom-content').replaceChildren(enlarged); $('image-zoom').showModal();
      }, 'image-open');
      view.setAttribute('aria-label', `Enlarge ${materialName(artifact)}`);
      view.append(img, el('span', 'Enlarge image', 'image-hint')); $('preview').replaceChildren(view);
    }
    else { const response = await fetch(artifact.url); if (!response.ok) throw new Error('Material could not be loaded. Choose it again.'); $('preview').replaceChildren(el('pre', await response.text())); }
    previewKey = artifact?.id || null;
  }
  const used = current.attempts.find(a => a.stage_id === active.id)?.used || 0;
  const checks = [...current.events].reverse().filter(e => e.operation === 'check_candidate' && e.stage_id === active.id);
  const finding = active.status === 'confirmed'
    ? checks.find(e => e.result.verification === 'confirmed')
    : checks.find(e => e.params._context?.branch_id === current.branch_id && e.result.candidate);
  $('finding').hidden = !finding?.result.candidate;
  if (finding?.result.candidate) {
    const verification = active.status === 'confirmed' ? 'confirmed' : finding.result.verification || 'unverified';
    $('finding').dataset.verification = verification;
    $('finding-label').textContent = verification === 'confirmed' ? 'Confirmed answer' : verification === 'unverified' ? 'Possible answer · not confirmed' : 'Answer did not match';
    $('finding-value').textContent = finding.result.candidate;
    const linked = current.hypothesis_tree.find(h => h.id === finding.params._context?.hypothesis_id);
    $('finding-reason').textContent = finding.result.explanation && !technicalCopy(finding.result.explanation) ? playerSentence(finding.result.explanation) : linked ? hypothesisCopy(linked).summary : 'See the ideas for the reasoning.';
  }

  const nodes = current.hypothesis_tree || [];
  const openReasoning = new Set([...document.querySelectorAll('details[data-hypothesis][open]')].map(d => `${d.dataset.surface}:${d.dataset.hypothesis}`));
  function hypothesisItem(h, surface) {
      const item = el('li', null, `hypothesis ${surface === 'next' ? 'next-card' : 'history-node'}${current.selected_hypothesis_id === h.id ? ' selected' : ''}`);
      const state = cardState(h, running);
      const copy = hypothesisCopy(h);
      item.dataset.checkStatus = state.status;
      const status = el('span', state.label, 'hypothesis-status'); status.dataset.status = state.status;
      item.append(status, el(surface === 'next' ? 'h3' : 'p', surface === 'next' ? copy.nextStep : copy.summary, 'hypothesis-summary'));
      if (surface === 'next') item.append(el('p', copy.summary, 'hypothesis-description'));
      const actions = el('div', null, 'hypothesis-actions');
      const relevantChecks = hypothesisChecks(h);
      const confirmed = current.stages.find(s => s.id === h.stage_id)?.status === 'confirmed';
      const exhausted = (current.attempts.find(a => a.stage_id === h.stage_id)?.used || 0) >= 3;
      const b = button(state.status === 'checking' ? 'Checking…' : confirmed ? 'Confirmed' : exhausted ? 'Checks finished' : relevantChecks.length ? 'Check again' : 'Check this idea', () => checkHypothesis(h));
      b.dataset.checkHypothesis = h.id;
      b.dataset.focusKey = `check:${surface}:${h.id}`;
      b.disabled = running || !connected || confirmed || exhausted;
      if (b.disabled) b.title = confirmed ? 'The answer is already confirmed.' : exhausted ? 'Continue in Mind to discuss this clue.' : running ? 'Mind is still checking.' : 'Open Mind to continue.';
      actions.append(b);
      const details = el('details'); details.dataset.hypothesis = h.id; details.dataset.surface = surface; details.open = openReasoning.has(`${surface}:${h.id}`);
      const summary = el('summary', 'Clues'); summary.dataset.focusKey = `reasoning:${surface}:${h.id}`;
      details.append(summary);
      for (const artifactId of h.artifact_ids) {
        const evidence = current.artifacts.find(a => a.id === artifactId);
        if (evidence) {
          const view = button(materialName(evidence), async () => { selectedArtifact = artifactId; await refresh(); $('preview').scrollIntoView({ block: 'nearest', behavior: 'auto' }); }, 'evidence-link');
          view.dataset.focusKey = `evidence:${surface}:${h.id}:${artifactId}`;
          view.setAttribute('aria-label', `View ${evidence.name}`); view.title = evidence.name;
          details.append(view);
        }
      }
      item.append(actions);
      if (state.outcome) item.append(el('p', state.outcome, 'hypothesis-outcome'));
      if (details.children.length > 1) item.append(details);
      return item;
  }
  function hypothesisList(parentId = null) {
    const list = el('ul', null, 'hypothesis-tree');
    for (const h of nodes.filter(n => n.parent_id === parentId)) {
      const item = hypothesisItem(h, 'history');
      if (nodes.some(n => n.parent_id === h.id)) item.append(hypothesisList(h.id));
      list.append(item);
    }
    return list;
  }
  const next = active.status === 'confirmed' ? nodes.filter(h => h.id === current.selected_hypothesis_id && h.stage_id === active.id) : nextHypotheses(nodes, active.id);
  if (next.length) {
    const list = el('ul', null, 'next-cards');
    list.append(...next.map(h => hypothesisItem(h, 'next')));
    $('hypotheses').replaceChildren(list);
  } else $('hypotheses').replaceChildren(el('p', active.status === 'confirmed' ? 'This stage is confirmed.' : running ? 'Mind is working. New hypotheses will appear here.' : 'No open hypotheses. Continue in the Mind chat.', 'quiet'));
  $('hypothesis-history').replaceChildren(nodes.length ? hypothesisList() : el('p', 'No saved branches yet.', 'quiet'));
  for (const h of active.hypotheses.filter(h => !nodes.some(n => n.id === h.id))) {
    const item = el('div', null, 'hypothesis');
    item.append(el('p', hypothesisCopy(h).summary)); $('hypothesis-history').append(item);
  }

  const latestRun = current.runs[0];
  const action = [...current.events].reverse().find(e => e.run_id === latestRun?.id && actionName(e));
  $('run-state').dataset.status = pendingHypothesis ? 'starting' : latestRun?.status || 'idle';
  $('run-state').textContent = pendingHypothesis ? 'Starting Mind…' : latestRun ? ({ running: action ? actionName(action) : 'Mind is investigating…', replied: active.status === 'confirmed' ? 'Answer confirmed.' : used >= 3 ? 'Checks finished. Continue in Mind.' : 'Choose an idea to check.', timed_out: 'Check stopped.', failed: 'Check stopped.', interrupted: 'Check stopped.' }[latestRun.status] || 'Continue in Mind.') : 'Clue saved. Continue in Mind.';
  const stopped = ['failed', 'timed_out', 'interrupted'].includes(latestRun?.status);
  $('run-detail').hidden = !stopped;
  $('run-detail').textContent = stopped ? 'Your clues and ideas are saved. Continue in Mind.' : '';
  $('resume-mind').hidden = running || !(stopped || used >= 3 && active.status !== 'confirmed' || !next.length && active.status !== 'confirmed' || !latestRun);
  } finally { restoreFocus(); }
}
$('close-image').onclick = () => $('image-zoom').close();
$('image-zoom').onclick = event => { if (event.target === $('image-zoom')) $('image-zoom').close(); };
$('image-zoom').onclose = () => $('zoom-content').replaceChildren();
if (matchMedia('(max-width: 960px)').matches) $('case-library').open = false;
await safely(async () => {
  if (linkedCaseId === null) return refresh();
  try { await loadCase(linkedCaseId); }
  catch (error) { await refresh(); $('case-library').open = true; throw new Error('This investigation is unavailable. Choose a saved case or send a new clue in Mind.'); }
})();
let pollPending = false;
setInterval(async () => { if (pollPending || document.hidden) return; pollPending = true; try { await refresh(); } catch (error) { notice(playerError(error.message)); } finally { pollPending = false; } }, 4000);
