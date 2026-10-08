import { get, put, del, BlobPreconditionFailedError } from '@vercel/blob';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, hash } from './store.js';
import { requireValue } from './operations.js';

export function workspaceOwner(owner) {
  requireValue(typeof owner === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(owner), 'Invalid workspace', 400);
  return owner.toLowerCase();
}
const options = () => ({ access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
async function blobRead(path) {
  const result = await get(path, { ...options(), useCache: false, headers: { 'Accept-Encoding': 'identity' } });
  if (!result) return null;
  requireValue(result.statusCode === 200, 'Storage read failed', 503);
  return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), etag: result.blob.etag };
}
async function indexRead(path) {
  const result = await blobRead(path);
  return result && { value: JSON.parse(result.bytes.toString()), etag: result.etag };
}
async function indexWrite(path, value, etag) {
  try {
    const result = await put(path, JSON.stringify(value), { ...options(), addRandomSuffix: false, allowOverwrite: Boolean(etag), ...(etag ? { ifMatch: etag } : {}), contentType: 'application/json' });
    return { value, etag: result.etag };
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) throw error;
    // A timed-out upload may already have committed; confirm its unique revision.
    const actual = await indexRead(path);
    if (actual?.value.revision === value.revision) return actual;
    throw error;
  }
}

// ponytail: small per-owner SQLite snapshots, serialized writes; move to hosted SQL when workspace volume warrants it.
export async function withWorkspace(owner, write, work) {
  owner = workspaceOwner(owner);
  const prefix = `workspaces/${owner}/`, indexPath = `${prefix}index.json`, leaseId = randomUUID();
  let index = await indexRead(indexPath), leased = false, store, directory;
  const garbage = new Set();
  if (write) {
    const deadline = Date.now() + 20_000;
    while (!leased) {
      if (!index || !index.value.lease || index.value.lease.until < Date.now()) {
        const value = { ...index?.value, database: index?.value.database || null, lease: { id: leaseId, until: Date.now() + 180_000 }, revision: randomUUID() };
        try { index = await indexWrite(indexPath, value, index?.etag); leased = true; }
        catch (error) {
          const current = await indexRead(indexPath);
          if (!current || (!(error instanceof BlobPreconditionFailedError) && current.etag === index?.etag)) throw error;
          index = current;
        }
      }
      if (!leased) {
        requireValue(Date.now() < deadline, 'Workspace is busy. Try again.', 409);
        await new Promise(done => setTimeout(done, 150 + Math.random() * 150));
        index = await indexRead(indexPath);
      }
    }
  }
  try {
    requireValue(index || write, 'Sign in to create your workspace', 401);
    directory = await mkdtemp(join(tmpdir(), 'riddlemaster-cloud-'));
    if (index.value.database) {
      let database;
      for (let retry = 0; retry < 3 && !database; retry++) {
        requireValue(index.value.database.startsWith(`${prefix}snapshots/`), 'Invalid workspace snapshot', 503);
        database = await blobRead(index.value.database);
        if (!database && !write) index = await indexRead(indexPath);
      }
      requireValue(database, 'Workspace snapshot is missing', 503);
      await writeFile(join(directory, 'riddlemaster.sqlite'), database.bytes);
    }
    store = new Store(directory, { recover: false });
    const uploaded = new Set();
    store.file = async artifactId => {
      const row = store.db.prepare('SELECT case_id FROM artifacts WHERE id=?').get(artifactId);
      requireValue(row, 'Saved clue was not found', 404);
      const artifact = store.artifact(artifactId, row.case_id);
      let bytes;
      try { bytes = await readFile(join(directory, 'artifacts', artifactId)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; bytes = (await blobRead(`${prefix}artifacts/${artifactId}`))?.bytes; }
      requireValue(bytes && hash(bytes) === artifact.sha256, 'Saved clue could not be verified', 503);
      return bytes;
    };
    const commit = async (release = false) => {
      requireValue(leased && index.value.lease?.id === leaseId && index.value.lease.until > Date.now(), 'Workspace lease expired. Retry the request.', 503);
      for (const artifactId of await readdir(join(directory, 'artifacts'))) {
        if (uploaded.has(artifactId)) continue;
        const bytes = await readFile(join(directory, 'artifacts', artifactId));
        const artifact = store.db.prepare('SELECT mime FROM artifacts WHERE id=?').get(artifactId);
        requireValue(artifact, 'Saved clue metadata is missing', 503);
        try { await put(`${prefix}artifacts/${artifactId}`, bytes, { ...options(), addRandomSuffix: false, allowOverwrite: false, contentType: artifact.mime }); }
        catch (error) {
          const saved = await blobRead(`${prefix}artifacts/${artifactId}`);
          if (!saved || hash(saved.bytes) !== hash(bytes)) throw error;
        }
        uploaded.add(artifactId);
      }
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const bytes = await readFile(join(directory, 'riddlemaster.sqlite'));
      requireValue(bytes.length <= 5 * 1024 * 1024, 'Workspace storage limit reached', 413);
      const database = `${prefix}snapshots/${randomUUID()}.sqlite`;
      await put(database, bytes, { ...options(), addRandomSuffix: false, contentType: 'application/octet-stream' });
      const prior = index.value.database;
      index = await indexWrite(indexPath, { database, lease: release ? null : { id: leaseId, until: Date.now() + 180_000 }, revision: randomUUID() }, index.etag);
      if (prior) garbage.add(prior);
      if (release) leased = false;
    };
    if (write) {
      store.db.prepare("UPDATE requests SET result=? WHERE json_extract(result,'$.status')='pending'").run(JSON.stringify({ status: 'interrupted', error: 'Request stopped before completion. Spent attempts are retained.' }));
      store.commitPending = commit;
    }
    let result, failure;
    try { result = await work(store); } catch (error) { failure = error; }
    if (write) await commit(true);
    if (failure) throw failure;
    return result;
  } finally {
    store?.close();
    if (leased) {
      try { await indexWrite(indexPath, { ...index.value, lease: null, revision: randomUUID() }, index.etag); } catch { /* Expiry permits recovery; never overwrite a newer writer. */ }
    }
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep + 'riddlemaster-cloud-')) await rm(directory, { recursive: true, force: true });
    if (garbage.size) await del([...garbage], { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {});
  }
}
