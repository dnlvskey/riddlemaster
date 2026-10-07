import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/minds.js';
import { Store, toolNames } from '../src/store.js';

const target = resolve('work', 'minds-connection');
mkdirSync(target, { recursive: true });
const string = { type: 'string' };
const stage = { stage_id: { type: 'string', description: 'Active stage UUID, omitted to use current_stage_id' } };
const props = {
  get_case_state: {},
  transform_artifact: { ...stage, artifact_id: string, operation: { type: 'string', enum: ['base64','hex','caesar','morse','xor','png_channel','invert','contrast'] }, params: { type: 'object', properties: { channel: { type: 'string', enum: ['red','green','blue','alpha'] }, normalize: { type: 'boolean', default: true }, factor: { type: 'number', minimum: 0.1, maximum: 32 }, shift: { type: 'integer', minimum: -25, maximum: 25 }, key: { type: 'string', minLength: 1, maxLength: 128 }, input_format: { type: 'string', enum: ['hex','text'], default: 'hex' } }, additionalProperties: false } },
  record_hypothesis: { ...stage, hypothesis_id: { type: 'string', description: 'Update an existing hypothesis in the active snapshot; omit to create a node' }, parent_id: { type: 'string', description: 'Optional parent hypothesis ID; defaults to selected hypothesis' }, text: { type: 'string', minLength: 1, maxLength: 4000 }, status: { type: 'string', enum: ['untested','supported','rejected'] }, artifact_ids: { type: 'array', items: string } },
  save_checkpoint: { label: { type: 'string', minLength: 1, maxLength: 120 } },
  restore_checkpoint: { checkpoint_id: string },
  check_candidate: { ...stage, candidate: { type: 'string', minLength: 1, maxLength: 400 } },
  begin_investigation: { source_url: { type: 'string', format: 'uri', description: 'Public HTTPS website/image source URL' }, source_text: { type: 'string', minLength: 1, description: 'Puzzle text, preserved as a UTF-8 artifact' }, files: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['name','mime','content_base64'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, mime: { type: 'string', enum: ['text/plain','image/png','image/jpeg','image/webp'] }, content_base64: { type: 'string', minLength: 1, maxLength: 5592408 } } } } },
  finish_investigation: { summary: { type: 'string', minLength: 1, maxLength: 4000, description: 'Evidence-based native run summary; does not confirm an answer' } }
};
const required = { get_case_state: [], transform_artifact: ['artifact_id','operation'], record_hypothesis: ['text','status'], save_checkpoint: ['label'], restore_checkpoint: ['checkpoint_id'], check_candidate: ['candidate'], begin_investigation: [], finish_investigation: ['summary'] };
const url = config().RIDDLEMASTER_PUBLIC_URL;
const paths = Object.fromEntries(['begin_investigation', ...toolNames].map(name => [`/tools/${name}`, { post: { operationId: name, summary: name.replaceAll('_', ' '), security: [{ toolConnection: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: name === 'begin_investigation' ? ['request_id','params'] : ['case_id','run_id','request_id','params'], additionalProperties: false, properties: { ...(name === 'begin_investigation' ? {} : { case_id: string, run_id: string }), request_id: { type: 'string', minLength: 8, maxLength: 100 }, params: { type: 'object', properties: props[name], required: required[name], additionalProperties: false } } } } } }, responses: { 200: { description: 'Persisted result; inspect status and verification. PNG artifact URLs require image attachment delivery.' }, 401: { description: 'Connection authentication missing or invalid' }, 409: { description: 'Closed run or request ID conflict' }, 422: { description: 'Recorded failed operation, attempt retained' }, 429: { description: 'Case/stage/run budget exhausted' } } } }]));
paths['/tools/begin_investigation'].post.requestBody.content['application/json'].schema.properties.params.anyOf = ['source_url','source_text','files'].map(key => ({ required: [key] }));
const spec = { openapi: '3.0.3', info: { title: 'Private Riddlemaster tool API', version: '0.1.0' }, ...(url ? { servers: [{ url }] } : {}), paths, components: { securitySchemes: { toolConnection: { type: 'http', scheme: 'bearer' } } } };
writeFileSync(resolve(target, 'openapi.json'), JSON.stringify(spec, null, 2));
const playbook = readFileSync('docs/skill-playbook.md', 'utf8');
writeFileSync(resolve(target, 'build-skill-prompt.md'), `Build a private Skill and App called Riddlemaster for my investigation workspace. Do not publish to Bazaar. Use this API only; require its Bearer Connection token. Never put credentials in the playbook. Show actual IDs, tools and access before using it.\n\n${playbook}\n\nAPI documentation:\n\n${JSON.stringify(spec, null, 2)}\n`);
const store = new Store(config().RIDDLEMASTER_DATA_DIR || 'data', { recover: false });
writeFileSync(resolve(target, 'connection.env'), `# Private token: enter only into the Riddlemaster Connection on HelloMinds. Never paste into conversation or submit as evidence.\nRIDDLEMASTER_TOOL_TOKEN=${store.setting('tool_token')}\n`);
store.close();
console.log(JSON.stringify({ status: url ? 'prepared' : 'needs_https_origin', directory: target, registered_with_minds: false, note: 'Private Connection credentials written locally; not printed. No platform entities created by this command.' }));
