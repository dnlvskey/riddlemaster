import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { requireValue, shortText, transform, validateFile } from './operations.js';
import { readInput, sourceInput, imageFile } from './source.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
const answerHash = value => hash(value.trim().toUpperCase());
const now = () => new Date().toISOString();
const id = () => randomUUID();
export const RUN_LIFETIME_MS = 15 * 60 * 1000;
export const toolNames = ['get_case_state', 'transform_artifact', 'record_hypothesis', 'save_checkpoint', 'restore_checkpoint', 'check_candidate', 'finish_investigation'];
function requireEvidence(evidence, distinct = true) {
  requireValue(Array.isArray(evidence) && evidence.length <= 100, 'Evidence must contain at most 100 distinct artifact IDs');
  for (const artifactId of evidence) requireValue(typeof artifactId === 'string' && artifactId.length === 36, 'Evidence must reference artifact IDs');
  requireValue(!distinct || new Set(evidence).size === evidence.length, 'Evidence must contain distinct artifact IDs');
}
function requireSafeHypotheses(state) {
  for (const stage of state.stages) for (const hypothesis of stage.hypotheses) requireEvidence(hypothesis.artifact_ids, false);
}
function requireBoundedParams(serialized) {
  requireValue(Buffer.byteLength(serialized, 'utf8') <= 32 * 1024, 'Tool or artifact parameters must be no larger than 32 KB', 413);
}

export class Store {
  constructor(directory, { recover = true } = {}) {
    this.directory = resolve(directory);
    mkdirSync(join(this.directory, 'artifacts'), { recursive: true });
    this.db = new DatabaseSync(join(this.directory, 'riddlemaster.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY,title TEXT NOT NULL,state TEXT NOT NULL,transforms INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,stage_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,parent_id TEXT,operation TEXT,params TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hypothesis_nodes (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,node TEXT NOT NULL,snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (case_id TEXT NOT NULL,stage_id TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(case_id,stage_id));
      CREATE TABLE IF NOT EXISTS oracle (case_id TEXT NOT NULL,stage_id TEXT NOT NULL,answer_hash TEXT NOT NULL,PRIMARY KEY(case_id,stage_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,alias TEXT NOT NULL,status TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,run_id TEXT,signature TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,case_id TEXT NOT NULL,run_id TEXT,stage_id TEXT,request_id TEXT,operation TEXT NOT NULL,params TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,run_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL);`);
    for (const key of ['ui_token', 'tool_token', 'media_key']) if (!this.setting(key)) this.setSetting(key, randomBytes(32).toString('hex'));
    if (recover) {
      this.db.prepare("UPDATE requests SET result=? WHERE json_extract(result,'$.status')='pending'").run(JSON.stringify({ status: 'interrupted', error: 'Process stopped before completion. Attempt retained; use a new request_id for a deliberate retry.' }));
      this.db.exec("UPDATE runs SET status='interrupted',error='Backend restarted before the run completed' WHERE status='running'");
    }
    // ponytail: one operator and serialized mutations; use per-case queues if concurrent users are added.
    this.queue = Promise.resolve();
  }
  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }
  setSetting(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value); }
  exclusive(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  tx(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  caseRow(caseId) {
    const row = this.db.prepare('SELECT * FROM cases WHERE id=?').get(caseId);
    requireValue(row, 'Case not found', 404);
    return row;
  }
  writeState(caseId, state) {
    requireSafeHypotheses(state);
    state.version++;
    this.db.prepare('UPDATE cases SET state=? WHERE id=?').run(JSON.stringify(state), caseId);
  }
  createCase(title) {
    const caseId = id(), stageId = id();
    const state = { version: 1, branch_id: id(), current_stage_id: stageId, stages: [{ id: stageId, title: 'Stage 1', notes: '', parent_id: null, status: 'open', artifact_ids: [], hypotheses: [] }] };
    this.db.prepare('INSERT INTO cases(id,title,state,created) VALUES(?,?,?,?)').run(caseId, shortText(title, 'Case title', 120), JSON.stringify(state), now());
    this.event(caseId, null, stageId, null, 'create_case', {}, { status: 'ok' });
    return this.getCase(caseId);
  }
  listCases() { return this.db.prepare('SELECT id,title,created FROM cases ORDER BY created DESC').all(); }
  artifact(artifactId, caseId) {
    const artifact = this.db.prepare('SELECT * FROM artifacts WHERE id=? AND case_id=?').get(artifactId, caseId);
    requireValue(artifact, 'Artifact not found', 404);
    requireBoundedParams(artifact.params);
    return { ...artifact, params: JSON.parse(artifact.params) };
  }
  file(artifactId) { return readFileSync(join(this.directory, 'artifacts', artifactId)); }
  addArtifact(caseId, stageId, name, mime, buffer, parentId = null, operation = 'upload', params = {}, active = true) {
    const state = JSON.parse(this.caseRow(caseId).state);
    const stage = state.stages.find(s => s.id === stageId);
    requireValue(stage, 'Stage not found', 404);
    requireSafeHypotheses(state);
    requireBoundedParams(JSON.stringify(params));
    const artifactId = id();
    writeFileSync(join(this.directory, 'artifacts', artifactId), buffer, { flag: 'wx' });
    this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run(artifactId, caseId, stageId, name, mime, hash(buffer), parentId, operation, JSON.stringify(params), now());
    if (active) { stage.artifact_ids.push(artifactId); this.writeState(caseId, state); }
    return this.artifact(artifactId, caseId);
  }
  async upload(caseId, stageId, name, mime, buffer) {
    const state = JSON.parse(this.caseRow(caseId).state);
    requireValue(state.stages.some(s => s.id === stageId), 'Stage not found', 404);
    requireValue(this.getCase(caseId).artifacts.length < 100, 'Artifact limit reached');
    name = shortText(name, 'File name', 120).replace(/[\/\\]/g, '_');
    let parentId = null;
    if (mime.startsWith('image/')) {
      const normalized = await imageFile(buffer, mime, name);
      requireValue(this.getCase(caseId).artifacts.length + (normalized.original ? 2 : 1) <= 100, 'Artifact limit reached');
      if (normalized.original) parentId = this.addArtifact(caseId, stageId, name, mime, buffer, null, 'upload_original', {}, false).id;
      buffer = normalized.bytes; mime = normalized.mime; name = normalized.name;
    } else await validateFile(buffer, mime);
    const result = this.addArtifact(caseId, stageId, name, mime, buffer, parentId);
    this.event(caseId, null, stageId, null, 'upload', { name: result.name }, { artifact_id: result.id, sha256: result.sha256 });
    return result;
  }
  addStage(caseId, title, notes, parentId) {
    const state = JSON.parse(this.caseRow(caseId).state);
    requireValue(state.stages.length < 30, 'Stage limit reached');
    requireValue(!parentId || state.stages.some(s => s.id === parentId), 'Parent stage not found');
    const stage = { id: id(), title: shortText(title, 'Stage title', 120), notes: String(notes ?? '').slice(0, 2000), parent_id: parentId || null, status: 'open', artifact_ids: [], hypotheses: [] };
    state.stages.push(stage);
    state.current_stage_id = stage.id;
    this.writeState(caseId, state);
    return stage;
  }
  selectStage(caseId, stageId) {
    const state = JSON.parse(this.caseRow(caseId).state);
    requireValue(state.stages.some(s => s.id === stageId), 'Stage not found');
    state.current_stage_id = stageId;
    this.writeState(caseId, state);
  }
  hypothesisTree(caseId) {
    return this.db.prepare('SELECT node FROM hypothesis_nodes WHERE case_id=? ORDER BY rowid').all(caseId).map(row => {
      const node = JSON.parse(row.node);
      requireEvidence(node.artifact_ids, false);
      return node;
    });
  }
  getCase(caseId) {
    this.expireRuns();
    const row = this.caseRow(caseId), state = JSON.parse(row.state);
    requireSafeHypotheses(state);
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE case_id=? ORDER BY created').all(caseId).map(a => {
      requireBoundedParams(a.params);
      return { ...a, params: JSON.parse(a.params) };
    });
    return { id: row.id, title: row.title, created: row.created, ...state, artifacts,
      hypothesis_tree: this.hypothesisTree(caseId),
      budgets: { transforms_used: row.transforms, transforms_remaining: 20 - row.transforms, candidate_limit: 3 },
      attempts: this.db.prepare('SELECT stage_id,used FROM attempts WHERE case_id=?').all(caseId),
      checkpoints: this.db.prepare('SELECT id,label,created FROM checkpoints WHERE case_id=? ORDER BY created').all(caseId),
      runs: this.db.prepare('SELECT * FROM runs WHERE case_id=? ORDER BY created DESC').all(caseId),
      messages: this.db.prepare('SELECT role,text,run_id,created FROM messages WHERE case_id=? ORDER BY created').all(caseId),
      events: this.db.prepare('SELECT * FROM events WHERE case_id=? ORDER BY seq').all(caseId).map(e => ({ ...e, params: JSON.parse(e.params), result: JSON.parse(e.result) })) };
  }
  mindState(caseId) {
    const c = this.getCase(caseId);
    const active = new Set(c.stages.flatMap(s => s.artifact_ids));
    return { ...c, artifacts: c.artifacts.filter(a => active.has(a.id)), events: undefined, messages: undefined, runs: undefined };
  }
  event(caseId, runId, stageId, requestId, operation, params, result) {
    const state = JSON.parse(this.caseRow(caseId).state);
    params = { ...params, _context: { branch_id: state.branch_id, hypothesis_id: state.selected_hypothesis_id || null } };
    this.db.prepare('INSERT INTO events(case_id,run_id,stage_id,request_id,operation,params,result,created) VALUES(?,?,?,?,?,?,?,?)').run(caseId, runId, stageId, requestId, operation, JSON.stringify(params), JSON.stringify(result), now());
  }
  eventOnce(caseId, runId, stageId, requestId, operation, params, result) {
    if (!this.db.prepare('SELECT 1 FROM events WHERE case_id=? AND run_id IS ? AND request_id IS ? AND operation=?').get(caseId, runId, requestId, operation)) this.event(caseId, runId, stageId, requestId, operation, params, result);
  }
  newRun(caseId, native = false) {
    this.caseRow(caseId);
    this.expireRuns();
    requireValue(!this.db.prepare("SELECT id FROM runs WHERE status='running'").get(), 'A Mind run is already in progress', 409);
    const run = { id: id(), alias: `${native ? 'native-' : ''}riddle-${caseId}`, case_id: caseId, status: 'running' };
    this.db.prepare('INSERT INTO runs(id,case_id,alias,status,created) VALUES(?,?,?,?,?)').run(run.id, caseId, run.alias, run.status, now());
    return run;
  }
  run(runId) {
    this.expireRuns();
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    requireValue(run, 'Run not found', 404);
    return run;
  }
  expireRuns() { this.db.prepare("UPDATE runs SET status='timed_out',error='Run exceeded its server lifetime; committed actions and budgets remain' WHERE status='running' AND created<?").run(new Date(Date.now() - RUN_LIFETIME_MS).toISOString()); }
  finishRun(runId, status, error = null) { this.db.prepare("UPDATE runs SET status=?,error=? WHERE id=? AND status='running'").run(status, error, runId); }
  message(caseId, runId, role, text) { this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id(), caseId, runId, role, text, now()); }
  checkpoint(caseId, label) {
    const checkpointId = id(), snapshot = this.caseRow(caseId).state;
    requireSafeHypotheses(JSON.parse(snapshot));
    this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?)').run(checkpointId, caseId, shortText(label, 'Checkpoint label', 120), snapshot, now());
    return { checkpoint_id: checkpointId };
  }
  restore(caseId, checkpointId) {
    const checkpoint = this.db.prepare('SELECT state FROM checkpoints WHERE id=? AND case_id=?').get(checkpointId, caseId);
    requireValue(checkpoint, 'Checkpoint not found', 404);
    const state = JSON.parse(checkpoint.state);
    this.hypothesisTree(caseId);
    state.branch_id = id();
    state.version = JSON.parse(this.caseRow(caseId).state).version;
    return this.tx(() => {
      this.writeState(caseId, state);
      return { branch_id: state.branch_id, state: this.mindState(caseId) };
    });
  }
  selectHypothesis(caseId, hypothesisId) {
    const row = this.db.prepare('SELECT node,snapshot FROM hypothesis_nodes WHERE id=? AND case_id=?').get(hypothesisId, caseId);
    requireValue(row, 'Saved hypothesis not found', 404);
    const node = JSON.parse(row.node), state = JSON.parse(row.snapshot);
    requireEvidence(node.artifact_ids, false);
    state.branch_id = id(); state.selected_hypothesis_id = node.id; state.current_stage_id = node.stage_id;
    state.version = JSON.parse(this.caseRow(caseId).state).version;
    this.writeState(caseId, state);
    this.event(caseId, null, node.stage_id, null, 'select_hypothesis', { hypothesis_id: node.id }, { status: 'ok' });
    return node;
  }
  async startInvestigation(requestId, value, native = false, channel = native ? 'authenticated_tool' : 'operator') {
    requireValue(typeof requestId === 'string' && /^[\w-]{8,100}$/.test(requestId), 'Provide a request_id of 8–100 alphanumeric characters');
    const input = sourceInput(value), url = input.source_url;
    const signature = hash(JSON.stringify({ operation: 'begin_investigation', ...(url && !input.source_text && !input.files.length ? { url } : { input }), native }));
    const prior = this.db.prepare('SELECT signature,result FROM requests WHERE id=?').get(requestId);
    if (prior) { requireValue(prior.signature === signature, 'request_id was already used for different parameters', 409); return JSON.parse(prior.result); }
    this.expireRuns();
    requireValue(!this.db.prepare("SELECT id FROM runs WHERE status='running'").get(), 'A Mind run is already in progress', 409);
    const c = this.createCase(url ? `Source · ${new URL(url).hostname}` : input.files[0]?.name || 'Text clue');
    this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(requestId, c.id, null, signature, JSON.stringify({ status: 'pending', case_id: c.id }));
    let result;
    try {
      const received = await readInput(input);
      this.db.prepare('UPDATE cases SET title=? WHERE id=?').run(shortText(received.title, 'Source title', 120), c.id);
      for (const file of received.files) {
        const provenance = { source_url: file.url || null, source_kind: received.source.kind, fetched_at: received.source.fetched_at, original_sha256: file.original_sha256 || hash(file.bytes), original_mime: file.original_mime || file.mime };
        let parentId = null;
        if (file.original) parentId = this.addArtifact(c.id, c.current_stage_id, file.original_name, file.original_mime, file.original, null, 'import_original', provenance, false).id;
        this.addArtifact(c.id, c.current_stage_id, file.name, file.mime, file.bytes, parentId, file.operation, provenance, file.active !== false);
      }
      const state = JSON.parse(this.caseRow(c.id).state);
      state.source = received.source;
      state.stages[0].notes = received.source.complete ? 'Investigate the saved source. No independent answer validator is configured.' : received.source.warnings.join('\n');
      this.writeState(c.id, state);
      const run = native ? this.newRun(c.id, true) : null;
      result = { status: 'ok', case_id: c.id, run_id: run?.id || null, state: this.mindState(c.id) };
      this.event(c.id, run?.id || null, c.current_stage_id, requestId, 'begin_investigation', { url, source_kind: received.source.kind, channel }, { status: 'ok', source: received.source, artifact_ids: this.mindState(c.id).artifacts.map(f => f.id) });
    } catch (error) {
      const state = JSON.parse(this.caseRow(c.id).state);
      state.source = { url, kind: url ? 'url' : input.files.length ? 'file' : 'text', complete: false, warnings: [error.message] };
      this.writeState(c.id, state);
      result = { status: 'failed', case_id: c.id, error: error.message };
      this.event(c.id, null, c.current_stage_id, requestId, 'begin_investigation', { url }, result);
    }
    this.db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(result), requestId);
    return result;
  }
  confirmByPlayer(caseId, stageId, candidate) {
    requireValue(!this.db.prepare('SELECT 1 FROM oracle WHERE case_id=? AND stage_id=?').get(caseId, stageId), 'Demo answers require the independent validator');
    const state = JSON.parse(this.caseRow(caseId).state);
    const stage = state.stages.find(s => s.id === stageId);
    requireValue(stage, 'Stage not found');
    stage.status = 'player_confirmed';
    stage.player_confirmation = { candidate: shortText(candidate, 'Candidate', 400), source: 'player', created: now() };
    this.writeState(caseId, state);
    this.event(caseId, null, stageId, null, 'player_confirmation', {}, stage.player_confirmation);
    return stage;
  }
  async call(caseId, runId, requestId, operation, params = {}) {
    requireValue(toolNames.includes(operation), 'Unknown tool');
    requireValue(typeof requestId === 'string' && /^[\w-]{8,100}$/.test(requestId), 'Provide a request_id of 8–100 alphanumeric characters');
    requireValue(params && typeof params === 'object' && !Array.isArray(params), 'params must be an object');
    if (operation === 'record_hypothesis') requireEvidence(params.artifact_ids ?? []);
    const prior = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
    if (!prior) requireBoundedParams(JSON.stringify(params));
    const signature = hash(JSON.stringify({ caseId, runId, operation, params }));
    if (prior) {
      requireValue(prior.signature === signature, 'request_id was already used for different parameters', 409);
      return JSON.parse(prior.result);
    }
    const row = this.caseRow(caseId);
    const state = JSON.parse(row.state);
    if (operation === 'record_hypothesis') requireSafeHypotheses(state);
    const stageId = params.stage_id || state.current_stage_id;
    const stage = state.stages.find(s => s.id === stageId);
    requireValue(stage, 'Stage not found', 404);
    const reused = this.tx(() => {
      const committed = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      if (committed) {
        requireValue(committed.signature === signature, 'request_id was already used for different parameters', 409);
        return JSON.parse(committed.result);
      }
      if (runId) {
        const run = this.run(runId);
        requireValue(run.case_id === caseId && run.status === 'running', 'Run is no longer accepting tool calls', 409);
        requireValue(run.calls < 30, 'Run tool-call limit reached', 429);
        this.db.prepare('UPDATE runs SET calls=calls+1 WHERE id=?').run(runId);
      }
      if (operation === 'transform_artifact') {
        requireValue(this.caseRow(caseId).transforms < 20, 'Transformation budget exhausted', 429);
        this.db.prepare('UPDATE cases SET transforms=transforms+1 WHERE id=?').run(caseId);
      }
      if (operation === 'check_candidate') {
        const used = this.db.prepare('SELECT used FROM attempts WHERE case_id=? AND stage_id=?').get(caseId, stageId)?.used ?? 0;
        requireValue(used < 3, 'Candidate budget exhausted for this stage', 429);
        this.db.prepare('INSERT INTO attempts VALUES(?,?,1) ON CONFLICT(case_id,stage_id) DO UPDATE SET used=used+1').run(caseId, stageId);
      }
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(requestId, caseId, runId, signature, JSON.stringify({ status: 'pending' }));
      return null;
    });
    if (reused) return reused;
    let result;
    try {
      if (operation === 'get_case_state') result = { state: this.mindState(caseId) };
      else if (operation === 'transform_artifact') {
        requireValue(stage.artifact_ids.includes(params.artifact_id), 'Choose an artifact in the active stage/branch');
        const source = this.artifact(params.artifact_id, caseId);
        const transformed = await transform(this.file(source.id), source.mime, params.operation, params.params);
        requireValue(this.getCase(caseId).artifacts.length < 100, 'Artifact limit reached');
        const artifact = this.addArtifact(caseId, stageId, `${params.operation}-${source.name.replace(/\.[^.]*$/, '')}.${transformed.mime === 'image/png' ? 'png' : 'txt'}`, transformed.mime, transformed.buffer, source.id, params.operation, params.params ?? {});
        result = { artifact, ...(artifact.mime === 'text/plain' ? { text: transformed.buffer.toString('utf8').slice(0, 8000) } : {}), stage_id: stageId };
      } else if (operation === 'record_hypothesis') {
        requireValue(['untested', 'supported', 'rejected'].includes(params.status), 'Hypothesis status must be untested, supported or rejected');
        const evidence = params.artifact_ids ?? [];
        requireValue(Array.isArray(evidence) && evidence.every(a => stage.artifact_ids.includes(a)), 'Evidence must reference artifacts in the active stage');
        const existing = params.hypothesis_id ? stage.hypotheses.find(h => h.id === params.hypothesis_id) : null;
        requireValue(!params.hypothesis_id || existing, 'Choose a hypothesis in the active stage/branch');
        const parentId = existing ? existing.parent_id || null : params.parent_id || state.selected_hypothesis_id || null;
        requireValue(!parentId || this.db.prepare('SELECT 1 FROM hypothesis_nodes WHERE id=? AND case_id=?').get(parentId, caseId), 'Parent hypothesis not found');
        requireValue(existing || this.getCase(caseId).hypothesis_tree.length < 100, 'Hypothesis limit reached');
        const presentation = {};
        for (const [field, limit] of [['summary', 240], ['next_step', 120]]) {
          if (params[field] !== undefined) presentation[field] = shortText(params[field], `Hypothesis ${field}`, limit);
        }
        if (params.kind !== undefined) {
          requireValue(['hypothesis', 'observation'].includes(params.kind), 'Hypothesis kind must be hypothesis or observation');
          presentation.kind = params.kind;
        }
        const hypothesis = { ...existing, id: existing?.id || id(), stage_id: stageId, parent_id: parentId,
          text: shortText(params.text, 'Hypothesis'), status: params.status, artifact_ids: evidence, ...presentation, branch_id: state.branch_id, created: existing?.created || now() };
        if (existing) Object.assign(existing, hypothesis); else stage.hypotheses.push(hypothesis);
        this.writeState(caseId, state);
        if (existing) this.db.prepare('UPDATE hypothesis_nodes SET node=? WHERE id=? AND case_id=?').run(JSON.stringify(hypothesis), hypothesis.id, caseId);
        else this.db.prepare('INSERT INTO hypothesis_nodes VALUES(?,?,?,?)').run(hypothesis.id, caseId, JSON.stringify(hypothesis), this.caseRow(caseId).state);
        result = { hypothesis };
      } else if (operation === 'save_checkpoint') result = this.checkpoint(caseId, params.label);
      else if (operation === 'restore_checkpoint') result = this.restore(caseId, params.checkpoint_id);
      else if (operation === 'finish_investigation') {
        requireValue(runId && this.run(runId).alias.startsWith('native-'), 'Finish requires an active native Mind run; SDK runs are closed by the application');
        const summary = shortText(params.summary, 'Investigation summary');
        this.message(caseId, runId, 'mind', summary);
        this.finishRun(runId, 'replied');
        result = { run_id: runId, summary };
      }
      else {
        const candidate = shortText(params.candidate, 'Candidate', 400);
        const explanation = params.explanation === undefined ? undefined : shortText(params.explanation, 'Candidate explanation', 240);
        const oracle = this.db.prepare('SELECT answer_hash FROM oracle WHERE case_id=? AND stage_id=?').get(caseId, stageId);
        const correct = oracle ? answerHash(candidate) === oracle.answer_hash : null;
        if (correct) {
          requireValue(!stage.parent_id || state.stages.find(s => s.id === stage.parent_id)?.status === 'confirmed', 'Confirm the previous stage first');
          stage.status = 'confirmed';
          const next = state.stages.find(s => s.parent_id === stage.id && s.status !== 'confirmed');
          if (next) state.current_stage_id = next.id;
          this.writeState(caseId, state);
        }
        result = { verification: correct === null ? 'unverified' : correct ? 'confirmed' : 'incorrect', source: oracle ? 'isolated_demo_validator' : 'no_oracle', candidate, stage_id: stageId, ...(explanation ? { explanation } : {}) };
      }
      result = { status: 'ok', ...result };
    } catch (error) { result = { status: 'failed', error: error.message }; }
    this.tx(() => {
      this.db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(result), requestId);
      this.event(caseId, runId, stageId, requestId, operation, params, result);
    });
    return result;
  }
  async createDemo(variant = 'a') {
    const key = Array.from(randomBytes(6), b => String.fromCharCode(65 + b % 26)).join('');
    const final = `${variant === 'b' ? 'LANTERN' : 'MERIDIAN'}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const c = this.createCase(`Hidden signal / ${variant.toUpperCase()}`);
    const firstId = c.current_stage_id;
    let state = JSON.parse(this.caseRow(c.id).state);
    state.stages[0].title = 'Find the hidden key';
    state.stages[0].notes = 'Inspect the original PNG channels. A six-letter uppercase key is hidden in the alpha channel. Record evidence and verify the key.';
    this.writeState(c.id, state);
    const svg = `<svg width="600" height="180" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="180" fill="black"/><text x="300" y="120" text-anchor="middle" font-family="monospace" font-size="90" font-weight="bold" fill="white">${key}</text></svg>`;
    const mask = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer();
    const pixels = Buffer.alloc(600 * 180 * 4);
    for (let i = 0; i < mask.length; i++) { pixels[i * 4] = 24; pixels[i * 4 + 1] = 24; pixels[i * 4 + 2] = 24; pixels[i * 4 + 3] = mask[i] > 100 ? 255 : 254; }
    const png = await sharp(pixels, { raw: { width: 600, height: 180, channels: 4 } }).png().toBuffer();
    await this.upload(c.id, firstId, 'signal.png', 'image/png', png);
    const second = this.addStage(c.id, 'Decode the final message', 'The file contains hexadecimal XOR bytes. Use the key confirmed in the previous stage, then validate the decoded final answer.', firstId);
    const plain = Buffer.from(final), keyBytes = Buffer.from(key);
    const cipher = Buffer.from(plain.map((byte, i) => byte ^ keyBytes[i % keyBytes.length])).toString('hex');
    await this.upload(c.id, second.id, 'payload.txt', 'text/plain', Buffer.from(cipher));
    this.db.prepare('INSERT INTO oracle VALUES(?,?,?)').run(c.id, firstId, answerHash(key));
    this.db.prepare('INSERT INTO oracle VALUES(?,?,?)').run(c.id, second.id, answerHash(final));
    this.selectStage(c.id, firstId);
    this.checkpoint(c.id, 'Original materials');
    return this.getCase(c.id);
  }
  close() { this.db.close(); }
}
