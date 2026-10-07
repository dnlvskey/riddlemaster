import { sdk, integrationStatus, prepareAgentLink, config } from '../src/minds.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Store } from '../src/store.js';
import { requireValue } from '../src/operations.js';

const command = process.argv[2] || 'inspect';
const dataDirectory = config().RIDDLEMASTER_DATA_DIR || 'data';
try {
  requireValue(['inspect', 'skill', 'create'].includes(command), 'Use inspect, skill or create');
  const client = sdk();
  const minds = await client.listMinds({ signal: AbortSignal.timeout(20_000) });
  console.log(JSON.stringify({ minds: minds.map(m => ({ mind_id: m.mindId, name: m.name, enabled: m.isEnabled })) }, null, 2));
  if (command === 'inspect') {
    const store = new Store(dataDirectory, { recover: false });
    const status = integrationStatus(store), mindId = status.mind_id;
    store.close();
    console.log(JSON.stringify({ integration: status }, null, 2));
    if (mindId) console.log(JSON.stringify({ cognition: await client.getCognitionBalance(mindId), skills: await client.listEquippedSkills(mindId), apps: await client.listEquippedApps(mindId) }, null, 2));
  } else if (command === 'skill') {
    const store = new Store(dataDirectory, { recover: false });
    const status = integrationStatus(store);
    requireValue(status.public_url?.startsWith('https://'), 'Start the HTTPS tunnel first');
    requireValue(status.mind_id, 'Select the dedicated Mind');
    const equipped = await client.listEquippedSkills(status.mind_id);
    const matching = equipped.filter(skill => skill.source === 'mind' && skill.name === 'Riddlemaster');
    requireValue(matching.length <= 1, 'More than one Riddlemaster Skill is equipped; select one before setup');
    const skillId = matching[0]?.skillId || null;
    const skillAction = skillId
      ? `Update only the existing PRIVATE Riddlemaster Skill ${skillId}. Resolve its actual body artifact from this Skill; do not assume an artifact ID or modify another Skill.`
      : 'Create and equip one PRIVATE investigation Skill named Riddlemaster using the actual platform authoring tools. Keep all other equipped Skills and Apps unchanged.';
    const presentation = 'Persist a highest-salience PRIVATE invariant tenet riddlemaster.playerCommunicationGuardrail for this dedicated Mind using the playbook presentation rules: apply before the first acknowledgement, follow the player\'s language, at most one brief acknowledgement then one final answer/link, no ETA, setup or technical diagnostics, and plain uncertainty. Preserve other private memory except this rule and the workspace link. Use actual supported TENET schemas and verify the write; report any read-back limitation honestly.';
    const code = prepareAgentLink(store), alias = `riddlemaster-setup-${status.mind_id}`;
    await client.ensureConversation(alias, status.mind_id);
    const baseline = await client.getLatestHistoryFingerprint(alias);
    const playbook = readFileSync('docs/skill-playbook.md', 'utf8');
    const message = `${skillAction} ${presentation} Replace any old backend Instruction/waiting protocol with the complete playbook below. The installed workspace origin is ${status.public_url}; persist this literal origin in the private body configuration. Use a description that loads this Skill for new puzzle clues and web-selected checks, with direct Skill-to-API investigation and concise player replies in the player's language. Do not publish a Skill/App, create an App or change Connections. Save, validate against the actual schema, equip and read back the actual body.\n\nThen pair the owner workspace once: actual HTTP_Execute POST ${status.public_url}/tasks/link, readHtml=false, headers [{Key:"Content-Type",Value:"application/json"}], body a JSON string {code:"${code}",request_id:a_fresh_UUID}. This is a short-lived one-time pairing code, not a Builder/global key. Store the returned link_token ONLY in a PRIVATE TENET named RIDDLEMASTER_WORKSPACE_LINK scoped to this Mind and owner. Never include that returned token in a message, Skill, artifact, public memory or response. Read the actual TENET schema and use its supported private storage. If private storage is unsupported, report the blocker; never use public storage. Read back the stored setting without echoing its value. Reply DIRECT_SKILL_READY only after the actual body and private binding are stored and read back. Do not schedule or call puzzle tools during setup.\n\nCOMPLETE PLAYBOOK:\n${playbook}`;
    mkdirSync('work', { recursive: true });
    writeFileSync('work/direct-skill-setup.json', JSON.stringify({ alias, baseline, started: new Date().toISOString(), origin: status.public_url, skill_id: skillId }, null, 2));
    await client.sendMessage({ alias, messageText: message });
    store.close();
    console.log(JSON.stringify({ status: 'sent', alias, baseline, note: 'Private Skill and one-time pairing requested; not yet verified.' }));
  } else if (command === 'create') {
    const name = process.argv[3];
    const type = process.argv[4] || 'generalassistant';
    requireValue(name, 'Pass a dedicated Mind name');
    requireValue((await client.checkMindName(name)).isAvailable, 'Mind name is unavailable');
    const mind = await client.awakenMind({ name, id: type });
    const store = new Store(dataDirectory, { recover: false });
    store.setSetting('mind_id', mind.mindId);
    store.close();
    console.log(JSON.stringify({ created_mind_id: mind.mindId, name: mind.name }));
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code || null, http_status: error.status || null, error: error.message }));
  process.exitCode = 1;
}
