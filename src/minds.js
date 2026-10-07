import { createMindsClient, parseHumanIdFromBuilderApiKey } from '@animocabrands/minds-client-lib';
import { parseEnv } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireValue } from './operations.js';
import { fetchSource, sourceInput } from './source.js';

export function config() {
  const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  return { ...process.env, ...local };
}
export function redactEvidence(value) {
  return JSON.parse(JSON.stringify(value).replace(/([?&]token=)[0-9a-f]{64}/gi, '$1[redacted]').replace(/R[ML]-[0-9a-f]{64}/gi, '[redacted]').replace(/Bearer [0-9a-f]{64}/gi, 'Bearer [redacted]'));
}
export function prepareAgentLink(store) {
  const code = `RM-${randomBytes(32).toString('hex')}`;
  store.setSetting('agent_pair_hash', createHash('sha256').update(code).digest('hex'));
  store.setSetting('agent_pair_expires', String(Date.now() + 30 * 60_000));
  store.setSetting('agent_pair_request', '');
  return code;
}
export function completeAgentLink(store, input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Provide a JSON object');
  requireValue(typeof input.request_id === 'string' && /^[\w-]{8,100}$/.test(input.request_id), 'Provide a request_id');
  requireValue(typeof input.code === 'string' && /^RM-[0-9a-f]{64}$/.test(input.code) && Date.now() < Number(store.setting('agent_pair_expires')) && createHash('sha256').update(input.code).digest('hex') === store.setting('agent_pair_hash'), 'Invalid or expired pairing code', 401);
  const prior = store.setting('agent_pair_request');
  requireValue(!prior || prior === input.request_id, 'Pairing code already used', 409);
  if (!prior) {
    store.setSetting('agent_link_token', `RL-${randomBytes(32).toString('hex')}`);
    store.setSetting('agent_link_expires', String(Date.now() + 7 * 24 * 60 * 60_000));
    store.setSetting('agent_link_owner', parseHumanIdFromBuilderApiKey(config().MINDS_BUILDER_API_KEY || '') || '');
    store.setSetting('agent_link_mind', integrationStatus(store).mind_id || '');
    store.setSetting('agent_pair_request', input.request_id);
  }
  return { link_token: store.setting('agent_link_token'), expires_at: new Date(Number(store.setting('agent_link_expires'))).toISOString() };
}
export function agentLinkAuthorized(store, authorization) {
  const status = integrationStatus(store);
  const expected = `Bearer ${store.setting('agent_link_token')}`;
  return Boolean(status.workspace_linked && typeof authorization === 'string' && Buffer.byteLength(authorization) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected)));
}
export function queueNativeTask(store, run, request) {
  store.setSetting(`native_task:${run.id}`, request);
}
export function claimNativeTask(store, input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Provide a JSON object');
  store.expireRuns();
  const run = store.db.prepare("SELECT * FROM runs WHERE status='running' ORDER BY created DESC LIMIT 1").get();
  requireValue(run && store.setting(`native_task:${run.id}`), 'No investigation is waiting. Resend the clue or choose its next check.', 409);
  requireValue(!input.case_id || input.case_id === run.case_id, 'The selected investigation is not the waiting task', 409);
  const alias = store.setting(`native_alias:${run.case_id}`);
  requireValue(alias?.startsWith('webapp:'), 'Task has no verified native conversation', 403);
  const state = store.mindState(run.case_id);
  state.artifacts = state.artifacts.map(a => ({ ...a, url: artifactUrl(store, a) }));
  store.eventOnce(run.case_id, run.id, state.current_stage_id, null, 'task_claim', {}, { status: 'ok', authentication: 'linked_mind' });
  return { case_id: run.case_id, run_id: run.id, request: store.setting(`native_task:${run.id}`), state, capability: runCapability(store, run.case_id, run.id), origin: integrationStatus(store).public_url, investigation_url: investigationUrl(run.case_id) };
}
export function runCapability(store, caseId, runId) {
  return createHmac('sha256', store.setting('tool_token')).update(`run:${caseId}:${runId}`).digest('hex');
}
function ownerNativeConversation(conversation, mindId, humanId) {
  const parties = conversation.participants || [];
  return Boolean(humanId && conversation.alias?.startsWith('webapp:') && parties.length === 2 && parties.some(p => p.partyType === 1 && p.partyId?.toLowerCase() === humanId.toLowerCase()) && parties.some(p => [0, 2].includes(p.partyType) && p.partyId?.toLowerCase() === mindId.toLowerCase()));
}
export function mediaToken(store, caseId, artifactId) {
  return createHmac('sha256', store.setting('media_key')).update(`${caseId}:${artifactId}`).digest('hex');
}
export function artifactUrl(store, artifact, external = true) {
  const origin = external ? config().RIDDLEMASTER_PUBLIC_URL?.replace(/\/$/, '') || '' : '';
  return `${origin}/media/${artifact.case_id}/${artifact.id}?token=${mediaToken(store, artifact.case_id, artifact.id)}`;
}
export function investigationUrl(caseId) {
  return `http://127.0.0.1:${Number(config().PORT || 4317)}/?case=${encodeURIComponent(caseId)}`;
}
export function sdk() {
  const key = config().MINDS_BUILDER_API_KEY;
  requireValue(key, 'MINDS_BUILDER_API_KEY is missing in the local .env', 503);
  return createMindsClient({ builderApiKey: key });
}
export function integrationStatus(store) {
  const env = config();
  const mindId = env.MINDS_MIND_ID || store.setting('mind_id') || null;
  const ownerId = env.MINDS_BUILDER_API_KEY && parseHumanIdFromBuilderApiKey(env.MINDS_BUILDER_API_KEY);
  const linked = Boolean(ownerId && mindId && store.setting('agent_link_token') && Date.now() < Number(store.setting('agent_link_expires')) && store.setting('agent_link_owner') === ownerId && store.setting('agent_link_mind') === mindId);
  return { provider: 'HelloMinds', sdk_version: '0.1.7', key_configured: Boolean(env.MINDS_BUILDER_API_KEY),
    mind_id: mindId,
    public_url: env.RIDDLEMASTER_PUBLIC_URL || null,
    app_ids: JSON.parse(store.setting('app_ids') || '[]'), skill_ids: JSON.parse(store.setting('skill_ids') || '[]'),
    connection_configured: store.setting('connection_configured') === 'true',
    execution_mode: 'native_skill', native_bridge_enabled: env.RIDDLEMASTER_NATIVE_BRIDGE === 'true',
    workspace_linked: linked,
    tools_ready: Boolean(linked && env.RIDDLEMASTER_PUBLIC_URL?.startsWith('https://') && env.RIDDLEMASTER_NATIVE_BRIDGE === 'true'),
    verified_run_id: store.setting('verified_run_id') || null };
}
export async function runMind(store, run, text) {
  try {
    const status = integrationStatus(store), client = sdk();
    const alias = store.setting(`native_alias:${run.case_id}`);
    requireValue(alias, 'Send this clue in the native Riddlemaster chat first', 503);
    const conversation = await client.getConversation(alias);
    requireValue(ownerNativeConversation(conversation, status.mind_id, parseHumanIdFromBuilderApiKey(config().MINDS_BUILDER_API_KEY)), 'The conversation must belong to this owner and Mind', 403);
    queueNativeTask(store, run, text);
    const sent = `Check the selected idea. [Open investigation](${investigationUrl(run.case_id)})`;
    store.setSetting(`native_outgoing:${createHash('sha256').update(sent).digest('hex')}`, run.id);
    store.message(run.case_id, run.id, 'operator', sent);
    store.event(run.case_id, run.id, null, null, 'minds_send', { alias, transport: 'native_skill' }, { status: 'sending' });
    await client.sendMessage({ alias, messageText: sent });
  } catch (error) {
    store.finishRun(run.id, 'failed', error.message);
    store.event(run.case_id, run.id, null, null, 'minds_error', {}, { status: 'failed', error: error.message });
  }
}
export function nativeSourceMessage(record, humanId) {
  if (record.senderType !== 1 || record.senderId?.toLowerCase() !== humanId.toLowerCase() || !record.fingerprint) return null;
  const raw = (record.messageText || '').replace(/^\[source:[^\]\r\n]+\](?:\r?\n| )?/, '');
  const text = /<\/(?:p|div|span|b|i|strong|em|code|a)\s*>|<br\s*\/?>/i.test(raw) ? raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:p|div|span|b|i|strong|em|code|a)(?:\s[^<>]*)?>/gi, '') : raw;
  const clean = text.trim();
  if (clean.startsWith('RIDDLEMASTER_BACKEND ') || /^(?:instruction:|\u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044f:)/i.test(clean)) return null;
  const attachments = record.attachments || [];
  if (attachments.length) return { text, attachments };
  // ponytail: obvious control phrases stay with the native chat; explicit message intents would replace this small heuristic.
  if (!clean || /^(?:continue|\u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438|\u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u0439|\u043e\u043a|ok|okay|hi|hello|\u043f\u0440\u0438\u0432\u0435\u0442|\u0441\u043f\u0430\u0441\u0438\u0431\u043e|thanks)[.!?\s]*$/i.test(clean) || /^(?:check (?:the |this )?(?:branch|hypothesis|selected idea)|\u043f\u0440\u043e\u0432\u0435\u0440\u044c (?:\u0432\u0435\u0442\u043a\u0443|\u0433\u0438\u043f\u043e\u0442\u0435\u0437\u0443|\u0432\u044b\u0431\u0440\u0430\u043d\u043d\u0443\u044e \u0432\u0435\u0440\u0441\u0438\u044e))(?:\s|[.!?:]|$)/i.test(clean)) return null;
  const urls = [...new Set((text.match(/https:\/\/[^\s<>"']+/g) || []).map(url => {
    let end = url.length;
    while (end && '.,);]}'.includes(url[end - 1])) end--;
    return url.slice(0, end);
  }))];
  return urls.length === 1 ? { url: urls[0], text } : { text, attachments: [] };
}
export async function nativeSourceInput(message) {
  const attachments = message.attachments || [];
  requireValue(Array.isArray(attachments) && attachments.length <= 4, 'Send up to four TXT, PNG, JPEG or WebP attachments');
  const files = [];
  for (const [index, attachment] of attachments.entries()) {
    requireValue(attachment && typeof attachment === 'object', 'Attachment metadata is missing');
    let mime = attachment.mimeType?.split(';')[0].toLowerCase(), content = attachment.artifact ?? attachment.content;
    if (content == null) {
      requireValue(typeof attachment.url === 'string', 'The attachment has no downloadable URL or file bytes. Resend the file or its public HTTPS link in the Mind chat');
      const received = await fetchSource(attachment.url);
      mime = received.mime === 'application/octet-stream' ? mime : received.mime;
      content = received.bytes.toString('base64');
    }
    const extension = ({ 'text/plain': 'txt', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime];
    requireValue(extension, 'Send TXT, PNG, JPEG or WebP');
    files.push({ name: attachment.fileName || `clue-${index + 1}.${extension}`, mime, content_base64: content });
  }
  return sourceInput({ source_url: message.url, source_text: message.text || '', files });
}

export function startNativeBridge(store) {
  let pending = null;
  // ponytail: one owner/Mind and bounded history polling; use SDK events plus paged replay for busy multi-user deployments.
  const tick = () => {
    if (!integrationStatus(store).tools_ready) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
    try {
      const env = config(), client = sdk(), humanId = parseHumanIdFromBuilderApiKey(env.MINDS_BUILDER_API_KEY);
      requireValue(humanId, 'Native intake requires an owner-bound Builder key');
      const mindId = integrationStatus(store).mind_id.toLowerCase();
      if (!store.setting('native_started_at')) store.setSetting('native_started_at', new Date().toISOString());
      const started = Date.parse(store.setting('native_started_at'));
      const conversations = await client.listConversations();
      for (const summary of conversations.filter(c => c.alias?.startsWith('webapp:'))) {
        const c = summary.participants ? summary : await client.getConversation(summary.alias);
        if (!ownerNativeConversation(c, mindId, humanId)) continue;
        const cursorKey = `native_cursor:${c.alias}`, cursor = store.setting(cursorKey);
        const rows = await client.getHistory(c.alias, { limit: 50, signal: AbortSignal.timeout(20_000) });
        const cursorIndex = rows.findIndex(r => r.fingerprint === cursor);
        const fresh = (cursorIndex < 0 ? rows : rows.slice(0, cursorIndex)).filter(r => Date.parse(r.createdAt) >= started).reverse();
        for (const row of fresh) {
          const raw = (row.messageText || '').replace(/^\[source:[^\]\r\n]+\](?:\r?\n| )?/, '').trim();
          if (store.setting(`native_outgoing:${createHash('sha256').update(raw).digest('hex')}`)) {
            store.setSetting(cursorKey, row.fingerprint);
            continue;
          }
          const input = nativeSourceMessage(row, humanId);
          if (input && !store.setting(`native_handled:${row.fingerprint}`)) {
            store.expireRuns();
            if (store.db.prepare("SELECT id FROM runs WHERE status='running'").get()) break;
            try {
              const requestId = `native-${createHash('sha256').update(row.fingerprint).digest('hex').slice(0, 32)}`;
              const source = await nativeSourceInput(input);
              const result = await store.exclusive(() => {
                store.expireRuns();
                return store.db.prepare("SELECT id FROM runs WHERE status='running'").get() ? null : store.startInvestigation(requestId, source, true, 'native_sdk');
              });
              if (!result) break;
              requireValue(result.status === 'ok', result.error || 'Source import was interrupted');
              store.setSetting(`native_alias:${result.case_id}`, c.alias);
              store.event(result.case_id, result.run_id, null, requestId, 'native_intake', { alias: c.alias, conversation_id: c.conversationId, human_message_fingerprint: row.fingerprint, source_kind: source.files.length ? 'file' : source.source_url ? 'url' : 'text' }, { status: 'accepted' });
              queueNativeTask(store, store.run(result.run_id), 'Investigate the saved clue from the player. Record observations, alternate hypotheses and real checks.');
              store.setSetting(`native_handled:${row.fingerprint}`, 'true');
            } catch (error) {
              store.setSetting(`native_handled:${row.fingerprint}`, 'true');
              store.setSetting('native_intake_error', error.message);
            }
          }
          store.setSetting(cursorKey, row.fingerprint);
        }
      }
      store.setSetting('native_bridge_error', '');
    } catch (error) { store.setSetting('native_bridge_error', error.message); console.error('Native intake:', error.message); }
    finally { pending = null; }
    })();
    return pending;
  };
  const timer = setInterval(tick, 15_000);
  void tick();
  return { sync: tick, stop: () => clearInterval(timer) };
}
