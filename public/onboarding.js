import { MindsOAuth, MindsScope, OAuthRedirectError } from '@animocabrands/minds-connect';
import { parseUserIdFromAccessToken } from '@animocabrands/minds-client-lib';

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const response = await fetch('/connect/config');
const config = await response.json();
let oauth, busy = false;
const scopes = [MindsScope.MindsList, MindsScope.MindsAwaken, MindsScope.MindsSkillsList, MindsScope.MindsSkillsEquip, MindsScope.ConversationsCreate, MindsScope.ConversationsList, MindsScope.ConversationsRead, MindsScope.MessagingSend, MindsScope.MessagingHistory];

async function createInvestigator() {
  if (busy) return;
  busy = true; $('connect').disabled = true;
  try {
    const token = await oauth.getAccessToken();
    const owner = token && parseUserIdFromAccessToken(token);
    if (!owner) throw new Error('Sign in again to continue.');
    const key = `riddlemaster_setup:${config.clientId}:${owner}`;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    status('Preparing your investigator…');
    const minds = await oauth.client.listMinds();
    let mind = minds.find(m => m.mindId === saved.mindId || saved.name && m.name === saved.name);
    if (!mind) {
      saved.name ||= `Riddlemaster-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem(key, JSON.stringify(saved));
      const check = await oauth.client.checkMindName(saved.name);
      if (!check.isAvailable) throw new Error('Your investigator could not be confirmed. Try again shortly.');
      mind = await oauth.client.awakenMind({ name: saved.name, id: 'generalassistant' });
      saved.mindId = mind.mindId;
      localStorage.setItem(key, JSON.stringify(saved));
    }
    const verified = (await oauth.client.listMinds()).find(m => m.mindId === mind.mindId);
    if (!verified) throw new Error('Your investigator was created, but could not be confirmed yet. Try again shortly.');
    $('mind-name').textContent = verified.name || saved.name;
    const chat = new URL('https://app.hellominds.ai/'); chat.searchParams.set('mindId', verified.mindId);
    $('open-mind').href = chat.href;
    $('result').hidden = false; $('connect').hidden = true;
    status('Your Mind is created. Puzzle workspace setup is the next step.');
    $('sign-out').hidden = false;
  } finally { busy = false; $('connect').disabled = false; }
}

async function safely(action) {
  try { await action(); }
  catch (error) {
    status(error instanceof OAuthRedirectError ? 'Sign-in was not completed. Try again.' : error.status === 403 ? 'The Minds connection does not allow this step yet.' : error.status === 401 ? 'Sign in again to continue.' : error.message?.startsWith('Your investigator') || error.message?.startsWith('Sign in again') ? error.message : 'Setup could not be completed. Try again.');
    $('connect').disabled = false;
  }
}
if (!config.clientId) {
  status('The test connection is being prepared.');
} else {
  oauth = new MindsOAuth({ clientId: config.clientId, redirectUri: config.redirectUri, scopes });
  $('connect').disabled = false;
  $('connect').onclick = () => safely(async () => {
    if (!oauth.tokens || !oauth.hasScopes(scopes)) await oauth.signIn();
    else await createInvestigator();
  });
  $('sign-out').onclick = () => safely(async () => { await oauth.signOut(); window.location.replace('/'); });
  await safely(async () => {
    if (window.location.pathname === '/callback') {
      await oauth.handleRedirect(); window.history.replaceState(null, '', '/');
      await createInvestigator();
    } else if (oauth.tokens && oauth.hasScopes(scopes)) {
      $('sign-out').hidden = false; status('Continue setting up your investigator.');
    } else status('Sign in with HelloMinds. Your Mind belongs to you.');
  });
}
