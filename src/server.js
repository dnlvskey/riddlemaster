import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Store, toolNames } from './store.js';
import { requireValue, shortText, operations } from './operations.js';
import { config, integrationStatus, mediaToken, artifactUrl, investigationUrl, runMind, redactEvidence, runCapability, startNativeBridge, completeAgentLink, agentLinkAuthorized, claimNativeTask } from './minds.js';

const store = new Store(resolve(config().RIDDLEMASTER_DATA_DIR || 'data'));
const port = Number(config().PORT || 4317);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function body(req) {
  let size = 0, parts = [];
  for await (const part of req) { size += part.length; requireValue(size <= 6 * 1024 * 1024, 'Request exceeds 6 MB', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Expected valid JSON'), { status: 400 }); }
}
function operator(req) {
  const cookie = /(?:^|;\s*)riddle_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  requireValue(equal(cookie, store.setting('ui_token')), 'Open Riddlemaster on localhost to authorize this browser', 401);
  if (req.method !== 'GET') requireValue(req.headers.origin === `http://127.0.0.1:${port}` || req.headers.origin === `http://localhost:${port}`, 'Operator mutations require the local application origin', 403);
}
function idle(caseId) { requireValue(!store.getCase(caseId).runs.some(r => r.status === 'running'), 'Wait for the current Mind run before changing the working state', 409); }
function mindReady() {
  return integrationStatus(store).tools_ready;
}
function toolURLs(result) {
  if (result.artifact) result.artifact.url = artifactUrl(store, result.artifact);
  if (result.state) result.state.artifacts = result.state.artifacts.map(a => ({ ...a, url: artifactUrl(store, a) }));
  return result;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const localHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
    if (req.method === 'GET' && path === '/' && localHost) {
      res.setHeader('Set-Cookie', `riddle_session=${store.setting('ui_token')}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return send(res, 200, readFileSync(resolve('public/index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && ['/app.js', '/style.css', '/fonts/space-grotesk.ttf'].includes(path)) {
      operator(req);
      const type = path.endsWith('.ttf') ? 'font/ttf' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      return send(res, 200, readFileSync(resolve(`public${path}`)), type);
    }
    if (req.method === 'GET' && path === '/health') return send(res, 200, { service: 'riddlemaster', status: 'up' });
    if (req.method === 'POST' && path === '/tasks/link') {
      const input = await body(req);
      return send(res, 200, await store.exclusive(() => completeAgentLink(store, input)));
    }
    if (req.method === 'POST' && path === '/tasks/claim') {
      requireValue(agentLinkAuthorized(store, req.headers.authorization), 'Link this Mind to the workspace first', 401);
      const input = await body(req);
      await nativeBridge.sync();
      return send(res, 200, await store.exclusive(() => claimNativeTask(store, input)));
    }
    const media = /^\/media\/([\w-]+)\/([\w-]+)$/.exec(path);
    if (media && req.method === 'GET') {
      requireValue(equal(url.searchParams.get('token'), mediaToken(store, media[1], media[2])), 'Invalid artifact capability', 403);
      const artifact = store.artifact(media[2], media[1]);
      return send(res, 200, store.file(artifact.id), `${artifact.mime}; charset=utf-8`);
    }
    const tool = /^\/tools\/([a-z_]+)$/.exec(path);
    if (tool && req.method === 'POST') {
      const input = await body(req);
      const connectionAuth = equal(req.headers.authorization, `Bearer ${store.setting('tool_token')}`);
      const runAuth = toolNames.includes(tool[1]) && input.case_id && input.run_id && equal(req.headers.authorization, `Bearer ${runCapability(store, input.case_id, input.run_id)}`);
      requireValue(connectionAuth || runAuth, 'A valid run-scoped capability or configured Connection is required', 401);
      if (tool[1] === 'begin_investigation') {
        const result = await store.exclusive(() => store.startInvestigation(input.request_id, input.params, true));
        return send(res, result.status === 'failed' ? 422 : 200, toolURLs(result));
      }
      requireValue(input.run_id, 'An active run_id is required');
      const result = await store.exclusive(async () => {
        const run = store.run(input.run_id);
        requireValue(run.case_id === input.case_id, 'Run does not belong to this case', 403);
        const retry = store.db.prepare('SELECT 1 FROM requests WHERE id=? AND case_id=? AND run_id=?').get(input.request_id || '', input.case_id, input.run_id);
        requireValue(run.status === 'running' || retry, 'Run is no longer accepting tool calls', 409);
        try {
          if (tool[1] === 'finish_investigation') requireValue(typeof input.params?.summary === 'string' && input.params.summary.trim().split(/\s+/).length <= 65, 'Keep the reply within 65 words');
          const result = await store.call(input.case_id, input.run_id, input.request_id, tool[1], input.params);
          if (tool[1] === 'finish_investigation' && result.status === 'ok') result.say = `${result.summary}\n\n[Open investigation](${investigationUrl(input.case_id)})`;
          store.eventOnce(input.case_id, input.run_id, input.params?.stage_id || null, input.request_id, 'tool_delivery', { operation: tool[1], authentication: runAuth ? 'run_capability' : 'platform_connection' }, { status: result.status });
          return result;
        }
        catch (error) {
          if (error.status === 429) store.eventOnce(input.case_id, input.run_id, input.params?.stage_id || null, null, tool[1], { request_id: input.request_id }, { status: 'blocked', error: error.message });
          throw error;
        }
      });
      return send(res, result.status === 'failed' ? 422 : 200, toolURLs(result));
    }
    operator(req);
    if (path === '/api/status' && req.method === 'GET') return send(res, 200, { ...integrationStatus(store), operations });
    if (path === '/api/cases' && req.method === 'GET') return send(res, 200, store.listCases());
    if (path === '/api/cases' && req.method === 'POST') {
      const input = await body(req);
      return send(res, 201, await store.exclusive(() => store.createCase(input.title)));
    }
    if (path === '/api/demo' && req.method === 'POST') {
      const input = await body(req);
      return send(res, 201, await store.exclusive(() => store.createDemo(input.variant === 'b' ? 'b' : 'a')));
    }
    if (path === '/api/source' && req.method === 'POST') {
      const input = await body(req);
      const result = await store.exclusive(async () => {
        const imported = await store.startInvestigation(input.request_id, input);
        if (imported.status === 'ok' && mindReady() && !imported.run_id) {
          const run = store.newRun(imported.case_id, true);
          imported.run_id = run.id;
          store.db.prepare('UPDATE requests SET result=? WHERE id=?').run(JSON.stringify(imported), input.request_id);
          runMind(store, run, 'Investigate the saved source. Record evidence and hypotheses. If essential source materials are missing, explain what is missing instead of guessing.');
        }
        return { ...imported, mind_pending: !mindReady() };
      });
      return send(res, result.status === 'failed' ? 422 : 201, result);
    }
    const caseRoute = /^\/api\/cases\/([\w-]+)(?:\/([a-z-]+))?$/.exec(path);
    if (caseRoute) {
      const caseId = caseRoute[1], action = caseRoute[2];
      if (!action && req.method === 'GET') {
        const c = store.getCase(caseId);
        c.artifacts = c.artifacts.map(a => ({ ...a, url: artifactUrl(store, a, false) }));
        return send(res, 200, c);
      }
      if (action === 'export' && req.method === 'GET') {
        const c = redactEvidence(store.getCase(caseId));
        res.setHeader('Content-Disposition', 'attachment; filename="riddlemaster-run.json"');
        return send(res, 200, { format: 'riddlemaster-evidence-v1', case: c, integration: integrationStatus(store), note: 'Actual application events. Non-null run_id means a run-scoped request, not independent proof of a HelloMinds caller. Correlate with minds_* SDK events or separately captured native conversation evidence. Oracle answer hashes, API credentials, artifact capability URLs and Connection tokens excluded.' });
      }
      requireValue(req.method === 'POST', 'Method not allowed', 405);
      const input = await body(req);
      if (action === 'chat' || action === 'check-hypothesis') {
        requireValue(mindReady(), 'Enable the configured native Riddlemaster bridge before starting an investigation', 503);
        let text = action === 'chat' ? shortText(input.text, 'Message') : '';
        const run = await store.exclusive(() => store.tx(() => {
          idle(caseId);
          if (action === 'check-hypothesis') {
            const hypothesis = store.selectHypothesis(caseId, input.hypothesis_id);
            text = `Check the selected hypothesis ${hypothesis.id}: ${hypothesis.text}. Start from its saved snapshot. Record actual checks and update this hypothesis with hypothesis_id. Create children only for a new line of investigation. Preserve spent attempts. Stop if the evidence cannot support a conclusion.`;
          }
          return store.newRun(caseId, true);
        }));
        runMind(store, run, text);
        return send(res, 202, run);
      }
      const result = await store.exclusive(async () => {
        idle(caseId);
        if (action === 'upload') {
          requireValue(typeof input.content_base64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64), 'Expected file bytes as Base64');
          return store.upload(caseId, input.stage_id, input.name, input.mime, Buffer.from(input.content_base64, 'base64'));
        }
        if (action === 'stages') return store.addStage(caseId, input.title, input.notes, input.parent_id);
        if (action === 'select-stage') return store.selectStage(caseId, input.stage_id) ?? { status: 'ok' };
        if (action === 'player-confirmation') return store.confirmByPlayer(caseId, input.stage_id, input.candidate);
        requireValue(action === 'tool', 'Route not found', 404);
        return store.call(caseId, null, input.request_id || randomUUID(), input.operation, input.params);
      });
      return send(res, result?.status === 'failed' ? 422 : 200, result);
    }
    throw Object.assign(new Error('Route not found'), { status: 404 });
  } catch (error) { send(res, error.status || 500, { status: 'failed', error: error.status ? error.message : 'The operation failed. Check the local server log.' }); if (!error.status) console.error(error); }
});
server.listen(port, '127.0.0.1', () => console.log(`Riddlemaster: http://127.0.0.1:${port} | Minds key: ${integrationStatus(store).key_configured ? 'configured' : 'missing'}`));
const nativeBridge = startNativeBridge(store);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { nativeBridge.stop(); server.close(() => { store.close(); process.exit(0); }); });
