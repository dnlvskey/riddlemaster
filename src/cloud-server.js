import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { toolNames } from './store.js';
import { withWorkspace } from './cloud-store.js';
import { origin, clientId, cookie, browserSession, checkSession, checkOrigin, validateTokens, saveTokens, authenticated, workspaceRuntime, equal, storedTokens } from './cloud-auth.js';
import { setupMind, confirmSetup, setupStatus } from './cloud-setup.js';
import { integrationStatus, sdk, mediaToken, artifactUrl, investigationUrl, runMind, runCapability, startNativeBridge, completeAgentLink, agentLinkAuthorized, claimNativeTask } from './minds.js';
import { requireValue, operations, shortText } from './operations.js';

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
async function body(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) { size += part.length; requireValue(size <= 4 * 1024 * 1024, 'Request exceeds 4 MB', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { requireValue(false, 'Expected valid JSON', 400); }
}
function urls(store, result) {
  if (result.artifact) result.artifact.url = artifactUrl(store, result.artifact);
  if (result.state) result.state.artifacts = result.state.artifacts.map(a => ({ ...a, url: artifactUrl(store, a) }));
  return result;
}
const publicFiles = new Map([
  ['/app.js', ['public/app.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']],
  ['/onboarding.css', ['public/onboarding.css', 'text/css']], ['/cloud-onboarding.js', ['public/cloud-onboarding.js', 'text/javascript']],
  ['/fonts/space-grotesk.ttf', ['public/fonts/space-grotesk.ttf', 'font/ttf']],
]);

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin()), path = url.pathname;
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && path === '/vendor/minds-connect.js') return send(res, 200, readFileSync(new URL('../node_modules/@animocabrands/minds-connect/dist/index.js', import.meta.url)), 'text/javascript');
    if (req.method === 'GET' && path === '/vendor/minds-client.js') return send(res, 200, readFileSync(new URL('../node_modules/@animocabrands/minds-client-lib/dist/index.js', import.meta.url)), 'text/javascript');
    if (req.method === 'GET' && publicFiles.has(path)) {
      const [file, type] = publicFiles.get(path);
      return send(res, 200, readFileSync(new URL(`../${file}`, import.meta.url)), type);
    }
    if (req.method === 'GET' && ['/', '/callback', '/workspace'].includes(path)) {
      if (path === '/workspace') {
        try { const session = browserSession(req); await withWorkspace(session.owner, false, store => checkSession(store, session)); }
        catch (error) { if (error.status !== 401) throw error; res.writeHead(302, { Location: `/?case=${encodeURIComponent(url.searchParams.get('case') || '')}` }); return res.end(); }
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        return send(res, 200, readFileSync(new URL('../public/index.html', import.meta.url)), 'text/html; charset=utf-8');
      }
      const nonce = randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'nonce-${nonce}'; connect-src 'self' https://api.oauth.hellominds.ai https://api.build.hellominds.ai; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      const html = readFileSync(new URL('../public/onboarding.html', import.meta.url), 'utf8').replace('IMPORT_NONCE', nonce).replace('/onboarding.js', '/cloud-onboarding.js');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && path === '/health') return send(res, 200, { service: 'riddlemaster', status: 'up' });
    if (req.method === 'GET' && path === '/connect/config') return send(res, 200, { clientId: clientId(), redirectUri: `${origin()}/callback` });
    if (req.method === 'POST' && path === '/connect/setup') {
      checkOrigin(req);
      const input = await body(req), verified = await validateTokens(input);
      let sessionId;
      const deliveries = [];
      const result = await withWorkspace(verified.owner, true, async store => {
        store.setSetting('cloud_owner', verified.owner);
        saveTokens(store, input);
        sessionId = store.setting('cloud_session') || randomBytes(32).toString('hex');
        store.setSetting('cloud_session', sessionId);
        await store.commitPending();
        return authenticated(store, verified.owner, () => setupMind(store), delivery => deliveries.push(delivery));
      });
      res.setHeader('Set-Cookie', cookie(verified.owner, sessionId));
      for (const deliver of deliveries) {
        try {
          await deliver();
          await withWorkspace(verified.owner, true, store => { if (store.setting('cloud_setup_phase') === 'sending') store.setSetting('cloud_setup_phase', 'sent'); });
          result.phase = 'sent';
        } catch (error) {
          console.error('Setup delivery failed:', error.status || '', error.code || error.name);
          await withWorkspace(verified.owner, true, store => store.setSetting('cloud_setup_phase', 'delivery_uncertain'));
          requireValue(false, 'Setup delivery could not be confirmed. Reconnect to check it.', 503);
        }
      }
      return send(res, result.phase === 'ready' ? 200 : 202, result);
    }
    const tenantRoute = /^\/w\/([0-9a-f-]{36})(\/.*)$/i.exec(path);
    if (tenantRoute) {
      const owner = tenantRoute[1].toLowerCase(), route = tenantRoute[2];
      const media = /^\/media\/([\w-]+)\/([\w-]+)$/.exec(route);
      if (media && req.method === 'GET') {
        const result = await withWorkspace(owner, false, async store => {
          requireValue(equal(url.searchParams.get('token'), mediaToken(store, media[1], media[2])), 'Invalid clue link', 403);
          const artifact = store.artifact(media[2], media[1]);
          return { bytes: await store.file(artifact.id), mime: artifact.mime };
        });
        return send(res, 200, result.bytes, result.mime);
      }
      requireValue(req.method === 'POST', 'Route not found', 404);
      const input = await body(req);
      const tool = /^\/tools\/([a-z_]+)$/.exec(route);
      requireValue(['/tasks/link', '/tasks/claim'].includes(route) || tool && toolNames.includes(tool[1]), 'Route not found', 404);
      // Reject unauthenticated calls before acquiring a write lease or creating storage.
      await withWorkspace(owner, false, store => workspaceRuntime(store, owner, () => {
        if (route === '/tasks/link') { completeAgentLink(store, input); return; }
        if (route === '/tasks/claim') requireValue(agentLinkAuthorized(store, req.headers.authorization), 'Link this Mind to the workspace first', 401);
        else requireValue(typeof input.case_id === 'string' && typeof input.run_id === 'string' && equal(req.headers.authorization, `Bearer ${runCapability(store, input.case_id, input.run_id)}`), 'Invalid investigation access', 401);
      }));
      const result = await withWorkspace(owner, true, async store => {
        if (route === '/tasks/link') {
          // Pairing itself needs no API access; owner binding comes from this authenticated workspace.
          return workspaceRuntime(store, owner, () => completeAgentLink(store, input));
        }
        if (route === '/tasks/claim') return authenticated(store, owner, async () => {
          requireValue(agentLinkAuthorized(store, req.headers.authorization), 'Link this Mind to the workspace first', 401);
          await startNativeBridge(store, { poll: false }).sync();
          return claimNativeTask(store, input);
        });
        requireValue(typeof input.case_id === 'string' && typeof input.run_id === 'string' && equal(req.headers.authorization, `Bearer ${runCapability(store, input.case_id, input.run_id)}`), 'Invalid investigation access', 401);
        return workspaceRuntime(store, owner, async () => {
          const run = store.run(input.run_id);
          requireValue(run.case_id === input.case_id, 'Run does not belong to this case', 403);
          const retry = store.db.prepare('SELECT 1 FROM requests WHERE id=? AND case_id=? AND run_id=?').get(input.request_id || '', input.case_id, input.run_id);
          requireValue(run.status === 'running' || retry, 'Run is no longer accepting tool calls', 409);
          if (tool[1] === 'finish_investigation') requireValue(typeof input.params?.summary === 'string' && input.params.summary.trim().split(/\s+/).length <= 65, 'Keep the reply within 65 words');
          const result = await store.call(input.case_id, input.run_id, input.request_id, tool[1], input.params);
          if (tool[1] === 'finish_investigation' && result.status === 'ok') result.say = `${result.summary}\n\n[Open investigation](${investigationUrl(input.case_id)})`;
          store.eventOnce(input.case_id, input.run_id, input.params?.stage_id || null, input.request_id, 'tool_delivery', { operation: tool[1], authentication: 'run_capability' }, { status: result.status });
          return urls(store, result);
        });
      });
      return send(res, result.status === 'failed' ? 422 : 200, result);
    }
    const session = browserSession(req);
    if (req.method !== 'GET') checkOrigin(req);
    if (path === '/connect/status' && req.method === 'GET') {
      const result = await withWorkspace(session.owner, true, async store => {
        checkSession(store, session);
        if (setupStatus(store).phase === 'ready') return setupStatus(store);
        return authenticated(store, session.owner, () => confirmSetup(store));
      });
      return send(res, 200, result);
    }
    if (path === '/connect/sign-out' && req.method === 'POST') {
      await withWorkspace(session.owner, true, async store => {
        checkSession(store, session);
        const tokens = storedTokens(store);
        const response = await fetch('https://api.oauth.hellominds.ai/v2/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId(), token: tokens.refreshToken }), signal: AbortSignal.timeout(20_000) });
        requireValue(response.ok, 'Sign-out could not be completed. Try again.', 503);
        store.setSetting('cloud_oauth', ''); store.setSetting('cloud_session', '');
        store.setSetting('agent_link_token', ''); store.setSetting('cloud_setup_phase', 'new');
        store.setSetting('tool_token', randomBytes(32).toString('hex')); store.setSetting('media_key', randomBytes(32).toString('hex'));
        store.db.exec("UPDATE runs SET status='interrupted',error='Owner signed out' WHERE status='running'");
      });
      res.setHeader('Set-Cookie', 'riddle_cloud=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { status: 'ok' });
    }
    const caseRoute = /^\/api\/cases\/([\w-]+)(?:\/([a-z-]+))?$/.exec(path);
    if (req.method === 'GET') {
      const result = await withWorkspace(session.owner, false, store => {
        checkSession(store, session);
        if (path === '/api/cases') return store.listCases();
        return workspaceRuntime(store, session.owner, () => {
          if (path === '/api/status') return { ...integrationStatus(store), operations };
          requireValue(caseRoute && !caseRoute[2], 'Route not found', 404);
          const result = store.getCase(caseRoute[1]);
          result.artifacts = result.artifacts.map(a => ({ ...a, url: artifactUrl(store, a) }));
          return result;
        });
      });
      return send(res, 200, result);
    }
    requireValue(caseRoute && req.method === 'POST', 'Route not found', 404);
    const input = await body(req), caseId = caseRoute[1], action = caseRoute[2], deliveries = [];
    const result = await withWorkspace(session.owner, true, async store => {
      checkSession(store, session);
      if (action === 'player-confirmation') {
        requireValue(!store.getCase(caseId).runs.some(r => r.status === 'running'), 'Wait for the current investigation', 409);
        return store.confirmByPlayer(caseId, input.stage_id, input.candidate);
      }
      if (action === 'select-stage') {
        requireValue(!store.getCase(caseId).runs.some(r => r.status === 'running'), 'Wait for the current investigation', 409);
        return store.selectStage(caseId, input.stage_id) ?? { status: 'ok' };
      }
      requireValue(['check-hypothesis', 'chat'].includes(action), 'Route not found', 404);
      requireValue(typeof input.request_id === 'string' && /^[\w-]{8,100}$/.test(input.request_id), 'Provide a request_id', 400);
      const prior = store.setting(`web_request:${input.request_id}`);
      if (prior) {
        const previous = JSON.parse(prior);
        requireValue(previous.case_id === caseId && previous.action === action && previous.hypothesis_id === (input.hypothesis_id || null) && previous.text === (input.text || null), 'Request ID was used for a different check', 409);
        return store.run(previous.run_id);
      }
      requireValue(!store.getCase(caseId).runs.some(r => r.status === 'running'), 'Wait for the current investigation', 409);
      return authenticated(store, session.owner, async () => {
        requireValue(integrationStatus(store).tools_ready, 'Reconnect your investigator to continue', 503);
        let text = action === 'chat' ? shortText(input.text, 'Message') : '';
        if (action === 'check-hypothesis') {
          const hypothesis = store.selectHypothesis(caseId, input.hypothesis_id);
          text = `Check the selected hypothesis ${hypothesis.id}: ${hypothesis.text}. Start from its saved snapshot. Record actual checks and update this hypothesis with hypothesis_id. Create children only for a new line of investigation. Preserve spent attempts. Stop if the evidence cannot support a conclusion.`;
        }
        const run = store.newRun(caseId, true);
        store.setSetting(`web_request:${input.request_id}`, JSON.stringify({ case_id: caseId, action, hypothesis_id: input.hypothesis_id || null, text: input.text || null, run_id: run.id }));
        await runMind(store, run, text);
        requireValue(store.run(run.id).status === 'running', 'The check could not be started. Reconnect your investigator.', 503);
        return run;
      }, delivery => deliveries.push(delivery));
    });
    for (const deliver of deliveries) {
      try { await deliver(); }
      catch {
        await withWorkspace(session.owner, true, store => { store.finishRun(result.id, 'failed', 'Message delivery could not be confirmed'); });
        requireValue(false, 'The check could not be delivered. Try again.', 503);
      }
    }
    return send(res, 202, result);
  } catch (error) {
    if (!error.status) console.error('Riddlemaster request failed:', error.name, error.code || '');
    send(res, error.status || 500, { status: 'failed', error: error.status ? error.message : 'This step could not be completed. Try again.' });
  }
});
server.listen(Number(process.env.PORT || 3000));
