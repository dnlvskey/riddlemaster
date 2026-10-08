import { randomUUID } from 'node:crypto';
import { sdk, config, prepareAgentLink, integrationStatus, sendAfterCommit } from './minds.js';
import { requireValue } from './operations.js';
import { skillSetupMessage } from './skill-setup.js';

export async function setupMind(store) {
  const client = sdk();
  const minds = await client.listMinds({ signal: AbortSignal.timeout(20_000) });
  let mind = minds.find(m => m.mindId === store.setting('mind_id')) || minds.find(m => m.name === store.setting('cloud_mind_name'));
  if (!mind) {
    requireValue(!store.setting('mind_id'), 'Your investigator is no longer available in this account', 409);
    let name = store.setting('cloud_mind_name');
    if (!name) {
      name = `Riddlemaster-${randomUUID().slice(0, 8)}`;
      store.setSetting('cloud_mind_name', name);
      await store.commitPending();
    }
    requireValue((await client.checkMindName(name)).isAvailable, 'Your investigator is being confirmed. Try again.', 409);
    await client.awakenMind({ name, id: 'generalassistant' });
    let verified;
    for (let check = 0; check < 5 && !verified; check++) {
      verified = (await client.listMinds()).find(m => m.name === name);
      if (!verified) await new Promise(done => setTimeout(done, 1000));
    }
    requireValue(verified, 'Your investigator could not be confirmed yet. Try again.', 409);
    mind = verified;
  }
  store.setSetting('mind_id', mind.mindId);
  store.setSetting('cloud_mind_name', mind.name);
  await store.commitPending();
  if (store.setting('cloud_setup_phase') === 'ready' && integrationStatus(store).workspace_linked) return setupStatus(store);
  if (['sent', 'sending', 'delivery_uncertain'].includes(store.setting('cloud_setup_phase'))) return confirmSetup(store);
  const skills = (await client.listEquippedSkills(mind.mindId)).filter(s => s.source === 'mind' && s.name === 'Riddlemaster');
  requireValue(skills.length <= 1, 'Your investigator has more than one Riddlemaster Skill', 409);
  const alias = `riddlemaster-setup-${mind.mindId}`;
  await client.ensureConversation(alias, mind.mindId);
  const conversation = await client.getConversation(alias);
  const parties = conversation.participants || [];
  const humans = parties.filter(p => p.partyType === 1);
  requireValue(parties.length === 2 && humans.length === 1 && typeof humans[0].partyId === 'string' && parties.some(p => [0, 2].includes(p.partyType) && p.partyId?.toLowerCase() === mind.mindId.toLowerCase()), 'Your investigator conversation could not be confirmed', 403);
  // OAuth user IDs differ from native human party IDs. Resolve the party from this authenticated conversation.
  store.setSetting('cloud_human_id', humans[0].partyId.toLowerCase());
  const baseline = await client.getLatestHistoryFingerprint(alias);
  const code = prepareAgentLink(store);
  store.setSetting('cloud_setup_alias', alias);
  store.setSetting('cloud_setup_baseline', baseline || '');
  store.setSetting('cloud_setup_phase', 'sending');
  store.setSetting('native_started_at', new Date().toISOString());
  // Persist the name and setup marker before external creation/sending; retry never awakens another Mind.
  await store.commitPending();
  try {
    const messageText = skillSetupMessage(config().RIDDLEMASTER_PUBLIC_URL, code, skills[0]?.skillId);
    await sendAfterCommit(() => client.sendMessage({ alias, messageText }));
  }
  catch (error) {
    store.setSetting('cloud_setup_phase', 'delivery_uncertain');
    throw Object.assign(new Error('Setup delivery could not be confirmed. Reconnect to check it.'), { status: 503 });
  }
  return setupStatus(store);
}
export function setupStatus(store) {
  return { phase: store.setting('cloud_setup_phase') || 'new', mind_id: store.setting('mind_id') || null, name: store.setting('cloud_mind_name') || null };
}
export async function confirmSetup(store) {
  const status = setupStatus(store);
  if (status.phase === 'ready' || !status.mind_id || !store.setting('cloud_setup_alias')) return status;
  const rows = await sdk().getHistory(store.setting('cloud_setup_alias'), { limit: 50, signal: AbortSignal.timeout(20_000) });
  const baseline = rows.findIndex(r => r.fingerprint === store.setting('cloud_setup_baseline'));
  const fresh = baseline < 0 ? rows : rows.slice(0, baseline);
  if (['sending', 'delivery_uncertain'].includes(status.phase)) {
    const delivered = fresh.some(r => r.senderType === 1 && r.senderId?.toLowerCase() === store.setting('cloud_human_id') && (r.messageText || '').includes('COMPLETE PLAYBOOK:') && (r.messageText || '').includes(config().RIDDLEMASTER_PUBLIC_URL));
    store.setSetting('cloud_setup_phase', delivered ? 'sent' : 'delivery_uncertain');
  }
  const ready = fresh.some(r => r.senderId?.toLowerCase() === status.mind_id.toLowerCase() && [0, 2].includes(r.senderType) && /\bDIRECT_SKILL_READY\b/.test(r.messageText || ''));
  if (ready && integrationStatus(store).workspace_linked) {
    const skills = (await sdk().listEquippedSkills(status.mind_id)).filter(s => s.source === 'mind' && s.name === 'Riddlemaster');
    if (skills.length === 1) {
      store.setSetting('skill_ids', JSON.stringify([skills[0].skillId]));
      store.setSetting('cloud_setup_phase', 'ready');
    }
  }
  return setupStatus(store);
}
