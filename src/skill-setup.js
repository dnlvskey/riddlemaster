import { readFileSync } from 'node:fs';

export function skillSetupMessage(origin, code, skillId = null) {
  const action = skillId
    ? `Update only the existing PRIVATE Riddlemaster Skill ${skillId}. Resolve its actual body artifact; do not assume an artifact ID or modify another Skill.`
    : 'Create and equip one PRIVATE investigation Skill named Riddlemaster using the actual platform authoring tools. Keep all other equipped Skills and Apps unchanged.';
  return `${action} Persist a highest-salience PRIVATE invariant tenet riddlemaster.playerCommunicationGuardrail: follow the player's language, at most one brief acknowledgement then one final answer/link, no ETA, setup or technical diagnostics, and plain uncertainty. Preserve other private memory except this rule and the workspace link. Use actual supported TENET schemas and verify the write. Replace any old backend Instruction/waiting protocol with the complete playbook below. The installed workspace origin is ${origin}; persist this literal origin in the private body configuration. Use a description that loads this Skill for new puzzle clues and web-selected checks. Do not publish a Skill/App, create an App or change Connections. Save, validate, equip and read back the actual body.

Then pair the owner workspace once: actual HTTP_Execute POST ${origin}/tasks/link, readHtml=false, headers [{Key:"Content-Type",Value:"application/json"}], body a JSON string {code:"${code}",request_id:a_fresh_UUID}. Reuse that request_id for an exact retry. This is a short-lived one-time pairing code. Store the returned link_token ONLY in a PRIVATE TENET named RIDDLEMASTER_WORKSPACE_LINK scoped to this Mind and owner. Never include that returned token in a message, Skill, artifact, public memory or response. Read the actual TENET schema and use its supported private storage. If private storage is unsupported, report the blocker; never use public storage. Read back the stored setting without echoing its value. Reply DIRECT_SKILL_READY only after the actual body and private binding are stored and read back. Do not schedule or call puzzle tools during setup.

COMPLETE PLAYBOOK:
${readFileSync(new URL('../docs/skill-playbook.md', import.meta.url), 'utf8')}`;
}
