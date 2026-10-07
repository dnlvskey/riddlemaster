import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.js';
import { integrationStatus, redactEvidence, config } from '../src/minds.js';
import { requireValue } from '../src/operations.js';

const store = new Store(config().RIDDLEMASTER_DATA_DIR || 'data', { recover: false });
try {
  const caseId = process.argv[2];
  requireValue(caseId, 'Pass the case UUID; inspect it in the local export first');
  const c = store.getCase(caseId);
  const label = process.argv[3] || 'operator-acceptance';
  requireValue(/^[\w-]+$/.test(label), 'Invalid evidence directory name');
  const runId = c.runs.find(run => run.id === label)?.id || null;
  requireValue(!/^[0-9a-f-]{36}$/i.test(label) || runId, 'Run UUID does not belong to this case');
  const target = resolve('evidence', label);
  mkdirSync(join(target, 'artifacts'), { recursive: true });
  const clean = redactEvidence(c);
  writeFileSync(join(target, 'case.json'), JSON.stringify(clean, null, 2));
  writeFileSync(join(target, 'api-events.jsonl'), clean.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(target, 'transcript.json'), JSON.stringify(clean.messages, null, 2));
  writeFileSync(join(target, 'integration.json'), JSON.stringify(integrationStatus(store), null, 2));
  for (const a of c.artifacts) copyFileSync(join(store.directory, 'artifacts', a.id), join(target, 'artifacts', `${a.id}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[a.mime] || 'txt'}`));
  const linked = runId ? c.events.filter(e => e.run_id === runId && ['transform_artifact','record_hypothesis','check_candidate'].includes(e.operation)) : [];
  writeFileSync(join(target, 'README.md'), `# Recorded Riddlemaster evidence\n\nCase: ${caseId}\nRun: ${runId || 'none (operator evidence)'}\nPackage label: ${label}\n\n${linked.length ? 'Run-scoped tool actions exist. A run_id alone does not prove a HelloMinds caller: correlate actual SDK messages/events or separately captured native conversation evidence. This statement does not certify end-to-end acceptance.' : 'This package does not demonstrate a successful live HelloMinds tool integration.'}\n\nOracle hashes, service tokens and Builder API key are excluded. Reproduce transformations using case.json parameters and immutable source artifacts.\n`);
  console.log(JSON.stringify({ directory: target, case_id: caseId, run_id: runId, evidence_label: label, run_scoped_actions: linked.length }));
} finally { store.close(); }
