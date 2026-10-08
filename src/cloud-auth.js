import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createMindsClient, parseUserIdFromAccessToken } from '@animocabrands/minds-client-lib';
import { requireValue } from './operations.js';
import { workspaceOwner } from './cloud-store.js';
import { withMindsRuntime } from './minds.js';

export const scopes = ['minds:list', 'minds:awaken', 'minds:skills:list', 'minds:skills:equip', 'conversations:create', 'conversations:list', 'conversations:read', 'messaging:send', 'messaging:history'];
export const origin = () => {
  const value = process.env.RIDDLEMASTER_WEB_ORIGIN;
  requireValue(value && new URL(value).protocol === 'https:', 'Cloud origin is not configured', 503);
  return new URL(value).origin;
};
export const clientId = () => process.env.MINDS_OAUTH_CLIENT_ID;
function key() {
  const secret = process.env.RIDDLEMASTER_SERVER_SECRET;
  requireValue(typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret), 'Server secret is not configured', 503);
  return Buffer.from(secret, 'hex');
}
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function sign(value) { return createHmac('sha256', key()).update(`browser:${value}`).digest('base64url'); }
export function cookie(owner, session) {
  const value = Buffer.from(JSON.stringify({ owner, session, expires: Date.now() + 7 * 86400_000 })).toString('base64url');
  return `riddle_cloud=${value}.${sign(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}
export function browserSession(req) {
  const value = /(?:^|;\s*)riddle_cloud=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  requireValue(value && value.length < 1000, 'Sign in to continue', 401);
  const [encoded, signature, extra] = value.split('.');
  requireValue(!extra && equal(signature, sign(encoded)), 'Sign in to continue', 401);
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url')); } catch { requireValue(false, 'Sign in to continue', 401); }
  requireValue(parsed.expires > Date.now() && typeof parsed.session === 'string', 'Sign in to continue', 401);
  return { ...parsed, owner: workspaceOwner(parsed.owner) };
}
export function checkOrigin(req) { requireValue(req.headers.origin === origin(), 'Request origin is not allowed', 403); }
export function checkSession(store, session) { requireValue(equal(session.session, store.setting('cloud_session')), 'Sign in to continue', 401); }
export function saveTokens(store, tokens) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(Buffer.from(store.setting('cloud_owner')));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  store.setSetting('cloud_oauth', Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64'));
}
export function storedTokens(store) {
  requireValue(store.setting('cloud_oauth'), 'Reconnect HelloMinds to continue', 401);
  const value = Buffer.from(store.setting('cloud_oauth'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12));
  decipher.setAAD(Buffer.from(store.setting('cloud_owner')));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]));
}
export async function validateTokens(tokens) {
  requireValue(tokens && typeof tokens.accessToken === 'string' && tokens.accessToken.length < 20_000 && typeof tokens.refreshToken === 'string' && tokens.refreshToken.length < 20_000 && typeof tokens.scope === 'string' && Number.isFinite(tokens.expiresAt), 'Invalid sign-in response', 400);
  requireValue(scopes.every(scope => tokens.scope?.split(' ').includes(scope)), 'Reconnect with the requested permissions', 403);
  const owner = workspaceOwner(parseUserIdFromAccessToken(tokens.accessToken));
  const client = createMindsClient({ accessToken: tokens.accessToken });
  // Parsing a token is not authentication: this owner-bound API call must succeed.
  const minds = await client.listMinds({ signal: AbortSignal.timeout(20_000) });
  return { owner, client, minds };
}
export async function authenticated(store, owner, work, afterCommit) {
  let tokens = storedTokens(store);
  if (tokens.expiresAt < Date.now() + 60_000) {
    requireValue(store.commitPending, 'Reconnect HelloMinds to continue', 401);
    const response = await fetch('https://api.oauth.hellominds.ai/v2/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId(), refresh_token: tokens.refreshToken })
    });
    requireValue(response.ok, 'Reconnect HelloMinds to continue', 401);
    const refreshed = await response.json();
    requireValue(typeof refreshed.accessToken === 'string' && typeof refreshed.refreshToken === 'string' && Number.isFinite(Number(refreshed.expiresIn)) && Number(refreshed.expiresIn) > 0 && scopes.every(scope => refreshed.scope?.split(' ').includes(scope)), 'Reconnect HelloMinds to continue', 401);
    tokens = { ...refreshed, expiresAt: Date.now() + Number(refreshed.expiresIn) * 1000 };
    requireValue(parseUserIdFromAccessToken(tokens.accessToken)?.toLowerCase() === owner, 'HelloMinds account changed. Reconnect.', 401);
    saveTokens(store, tokens);
    await store.commitPending();
  }
  return workspaceRuntime(store, owner, work, createMindsClient({ accessToken: tokens.accessToken }), afterCommit);
}
export function workspaceRuntime(store, owner, work, client, afterCommit) {
  return withMindsRuntime({ client, afterCommit,
    env: { MINDS_OWNER_ID: owner, MINDS_HUMAN_ID: store.setting('cloud_human_id') || '', MINDS_MIND_ID: store.setting('mind_id') || '', MINDS_AUTHENTICATED: Boolean(store.setting('cloud_oauth')), MINDS_BUILDER_API_KEY: '', RIDDLEMASTER_PUBLIC_URL: `${origin()}/w/${owner}`, RIDDLEMASTER_WEB_URL: `${origin()}/workspace`, RIDDLEMASTER_NATIVE_BRIDGE: 'true' }
  }, work);
}
