import { MindsOAuth, MindsScope, TokenStore } from '@animocabrands/minds-connect';

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const scopes = [MindsScope.MindsList, MindsScope.MindsAwaken, MindsScope.MindsSkillsList, MindsScope.MindsSkillsEquip, MindsScope.ConversationsCreate, MindsScope.ConversationsList, MindsScope.ConversationsRead, MindsScope.MessagingSend, MindsScope.MessagingHistory];
const caseId = new URL(location.href).searchParams.get('case');
const workspace = '/workspace' + (caseId ? '?case=' + encodeURIComponent(caseId) : '');
class HandoffStore extends TokenStore {
  get() { return this.parseSession(sessionStorage.getItem(this.sessionKey)); }
  set(value) { sessionStorage.setItem(this.sessionKey, JSON.stringify(value)); }
  clear() { sessionStorage.removeItem(this.sessionKey); }
}
async function api(path, value) {
  const response = await fetch(path, value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Setup could not be completed. Try again.'), { status: response.status });
  return result;
}
let checking = false;
async function followSetup(initial, destination = workspace) {
  $('connect').hidden = true; $('sign-out').hidden = false;
  status('Preparing your investigator…');
  if (checking) return;
  checking = true;
  try {
    let result = initial;
    while (true) {
      if (!result) result = await api('/connect/status');
      if (result.mind_id) {
        $('mind-name').textContent = result.name || 'Riddlemaster';
        $('open-mind').href = 'https://app.hellominds.ai/?mindId=' + encodeURIComponent(result.mind_id);
        $('result').hidden = false;
        status('Your Mind is created. Connecting your investigator…');
      }
      if (result.phase === 'ready') { location.replace(destination); return; }
      if (result.phase === 'delivery_uncertain') throw new Error('Your investigator setup needs another check. Sign in again to continue.');
      await new Promise(done => setTimeout(done, 5000));
      result = null;
    }
  } finally { checking = false; }
}
async function safely(work) {
  try { await work(); }
  catch (error) {
    status(error.status === 401 ? 'Sign in to continue.' : error.status === 403 ? 'The Minds connection does not allow this step yet.' : error.message);
    $('connect').hidden = false; $('connect').disabled = false;
  }
}
await safely(async () => {
  const config = await api('/connect/config');
  const storage = new HandoffStore(config.clientId);
  const oauth = new MindsOAuth({ ...config, scopes, storage });
  $('connect').disabled = false;
  $('connect').onclick = () => safely(async () => {
    $('connect').disabled = true;
    await oauth.signIn({ state: { caseId } });
  });
  $('sign-out').onclick = () => safely(async () => { await api('/connect/sign-out', {}); storage.clear(); location.replace('/'); });
  if (location.pathname === '/callback') {
    const redirect = await oauth.handleRedirect();
    const tokens = storage.get();
    if (redirect.state?.caseId) sessionStorage.setItem('riddlemaster_return_case', redirect.state.caseId);
    const result = await api('/connect/setup', tokens);
    storage.clear();
    const savedCase = sessionStorage.getItem('riddlemaster_return_case');
    sessionStorage.removeItem('riddlemaster_return_case');
    history.replaceState(null, '', '/' + (savedCase ? '?case=' + encodeURIComponent(savedCase) : ''));
    if (savedCase && result.phase === 'ready') { location.replace('/workspace?case=' + encodeURIComponent(savedCase)); return; }
    await followSetup(result, savedCase ? '/workspace?case=' + encodeURIComponent(savedCase) : '/workspace');
  } else {
    try { await followSetup(await api('/connect/status')); }
    catch (error) { if (error.status !== 401) throw error; status('Sign in with HelloMinds. Your Mind belongs to you.'); }
  }
});
