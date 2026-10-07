import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { requireValue, shortText, validateFile, validBase64 } from './operations.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
export function sourceInput(value) {
  const input = typeof value === 'string' ? { source_url: value } : value;
  requireValue(input && typeof input === 'object', 'Provide a link, text or image');
  const url = input.source_url ? sourceURL(input.source_url).href : null;
  const text = input.source_text ?? '';
  requireValue(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024, 'Source text must be UTF-8 and no larger than 4 MB');
  const files = input.files ?? [];
  requireValue(Array.isArray(files) && files.length <= 4, 'Choose up to four source files');
  requireValue(url || text.trim() || files.length, 'Provide a link, text or image');
  for (const file of files) {
    requireValue(file && typeof file === 'object', 'Expected a source file');
    shortText(file.name, 'File name', 120);
    requireValue(file.mime === 'text/plain' || Object.hasOwn(imageTypes, file.mime), 'Choose TXT, PNG, JPEG or WebP');
    requireValue(typeof file.content_base64 === 'string' && file.content_base64.length <= 5592408 && validBase64(file.content_base64), 'Expected valid file bytes as Base64');
  }
  return { source_url: url, source_text: text, files: files.map(file => ({ name: file.name.trim().replace(/[\/\\]/g, '_'), mime: file.mime, content_base64: file.content_base64 })) };
}
export async function imageFile(bytes, mime, name = 'source-image.png', url = null) {
  requireValue(Object.hasOwn(imageTypes, mime), 'Choose PNG, JPEG or WebP');
  requireValue(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'Image must contain 1 byte–4 MB');
  const meta = await sharp(bytes, { limitInputPixels: 10000000 }).metadata();
  requireValue(meta.format === imageTypes[mime] && (meta.pages ?? 1) === 1, 'Choose one static image matching its file type');
  const normalized = mime === 'image/png' ? bytes : await sharp(bytes, { limitInputPixels: 10000000 }).png().toBuffer();
  await validateFile(normalized, 'image/png');
  return { name: name.replace(/\.[^.]+$/, '') + '.png', mime: 'image/png', bytes: normalized, url, operation: 'import_image', original_sha256: hash(bytes), original_mime: mime, ...(mime !== 'image/png' ? { original: bytes, original_name: name } : {}) };
}
export async function readInput(value) {
  const input = sourceInput(value);
  const received = input.source_url ? await readSource(input.source_url) : { title: input.files[0]?.name || 'Text clue', files: [], source: { url: null, kind: input.files.length ? 'file' : 'text', fetched_at: new Date().toISOString(), complete: true, warnings: [], method: input.files.length ? 'uploaded_file' : 'inline_text' } };
  if (input.source_text.trim()) {
    const bytes = Buffer.from(input.source_text);
    await validateFile(bytes, 'text/plain');
    received.files.push({ name: 'clue-text.txt', mime: 'text/plain', bytes, url: null, operation: 'import_text' });
  }
  for (const file of input.files) {
    const bytes = Buffer.from(file.content_base64, 'base64');
    if (file.mime === 'text/plain') {
      await validateFile(bytes, file.mime);
      received.files.push({ name: file.name, mime: file.mime, bytes, url: null, operation: 'import_text' });
    } else received.files.push(await imageFile(bytes, file.mime, file.name));
  }
  requireValue(received.files.length, 'The source is empty');
  if (!input.source_url) received.source.sha256 = hash(Buffer.concat(received.files.map(file => file.original || file.bytes)));
  return received;
}
export function publicAddress(address) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0|2):/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    && !(a === 203 && b === 0 && c === 113);
}
export function sourceURL(value) {
  let url;
  try { url = new URL(shortText(value, 'Source URL', 2000)); } catch { throw Object.assign(new Error('Enter a valid public HTTPS URL'), { status: 400 }); }
  requireValue(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password, 'Source must use HTTPS without credentials or a custom port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  requireValue(!/^(localhost|.*\.(localhost|local|internal|invalid|test))$/i.test(host) && (!isIP(host) || publicAddress(host)), 'Source address must be public');
  url.hash = '';
  return url;
}
export async function fetchSource(value, redirects = 0, signal = AbortSignal.timeout(90000)) {
  const url = sourceURL(value);
  const addresses = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Source DNS lookup timed out')), 5000); timer.unref(); })]);
  requireValue(addresses.length && addresses.every(a => publicAddress(a.address)), 'Source resolves to a non-public address');
  const address = addresses[0];
  // Pin the checked address so a second DNS answer cannot redirect the request into the local network.
  const result = await new Promise((resolve, reject) => {
    const req = request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), family: address.family,
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'Riddlemaster/0.1 source importer', Accept: 'text/html,text/plain,application/json,image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) res.destroy(Object.assign(new Error('Source exceeds 4 MB'), { status: 413 })); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ url: url.href, status: res.statusCode, location: res.headers.location, mime: String(res.headers['content-type'] || '').split(';')[0].toLowerCase(), bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    requireValue(redirects < 3 && result.location, 'Source redirect limit reached');
    return fetchSource(new URL(result.location, url).href, redirects + 1, signal);
  }
  requireValue(result.status >= 200 && result.status < 300, `Source returned HTTP ${result.status}; access may be required`, 422);
  return result;
}
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()] ?? match;
    const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}
function* htmlTokens(html, omitRaw = false) {
  const rawEnds = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi, noscript: /<\/noscript\s*>/gi }, unclosed = new Set();
  let offset = 0, textStart = 0;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) { yield html.slice(textStart); return; }
    const first = html[start + (html[start + 1] === '/' ? 2 : 1)];
    if (!first || !/[a-z!?]/i.test(first)) { offset = start + 1; continue; }
    const end = html.indexOf('>', start + 1);
    if (end < 0) { yield html.slice(textStart); return; }
    if (start > textStart) yield html.slice(textStart, start);
    const raw = html.slice(start, end + 1), match = /^<(\/?)([a-z][a-z0-9:-]*)\b/i.exec(raw);
    const name = match?.[2].toLowerCase(), closing = Boolean(match?.[1]);
    offset = textStart = end + 1;
    if (omitRaw && !closing && Object.hasOwn(rawEnds, name) && !unclosed.has(name)) {
      const close = rawEnds[name]; close.lastIndex = offset;
      if (close.exec(html)) { offset = textStart = close.lastIndex; yield ' '; continue; }
      // An absent closer is searched only once per raw-text tag, even for repeated opening tags.
      unclosed.add(name);
    }
    yield { raw, name, closing, start, end: offset };
  }
  if (textStart < html.length) yield html.slice(textStart);
}
export function htmlText(html) {
  const parts = [];
  for (const token of htmlTokens(html, true)) parts.push(typeof token === 'string' ? token : token.name === 'br' || token.closing && ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(token.name) ? '\n' : ' ');
  return decode(parts.join(''))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function htmlTitle(html) {
  let start = null;
  for (const token of htmlTokens(html)) {
    if (typeof token === 'string' || token.name !== 'title') continue;
    if (!token.closing && start === null) start = token.end;
    else if (token.closing && start !== null) return htmlText(html.slice(start, token.start));
  }
  return '';
}
function hasVideoMetadata(html) {
  for (const token of htmlTokens(html)) if (token.name === 'meta' && !token.closing && /(?:property|name)\s*=\s*["']og:video/i.test(token.raw)) return true;
  return false;
}
function images(html, base, isX) {
  const urls = new Set();
  for (const token of htmlTokens(html)) {
    if (token.closing || !['img', 'meta'].includes(token.name)) continue;
    if (token.name === 'meta' && !/(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["']/i.test(token.raw)) continue;
    const value = /(?:src|content)\s*=\s*["']([^"']+)["']/i.exec(token.raw)?.[1];
    if (value) { try {
      const url = sourceURL(new URL(decode(value), base).href);
      if (!isX || url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) urls.add(url.href);
      if (urls.size === 5) break;
    } catch {} }
  }
  return [...urls];
}
export async function readSource(value) {
  const signal = AbortSignal.timeout(90000);
  const original = sourceURL(value), isX = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(original.hostname);
  if (isX) requireValue(/^\/[^/]+\/status\/\d+\/?$/.test(original.pathname), 'Choose an individual public X post URL');
  const transport = isX ? `https://publish.x.com/oembed?url=${encodeURIComponent(original.href)}&omit_script=true` : original.href;
  const received = await fetchSource(transport, 0, signal), files = [], warnings = [];
  let title = original.hostname, html = '', text = '', complete = true, supportingPage = null, expectsXImage = false;
  if (isX) {
    const embed = JSON.parse(received.bytes.toString('utf8'));
    requireValue(typeof embed.html === 'string', 'X did not return readable public post content', 422);
    html = embed.html; title = `${embed.author_name || 'X'} · puzzle source`; text = htmlText(html);
    files.push({ name: 'x-original-oembed.json.txt', mime: 'text/plain', bytes: received.bytes, url: received.url, operation: 'import_original' });
    expectsXImage = /pic\.twitter\.com|\/photo\//i.test(html);
    try {
      const page = await fetchSource(original.href, 0, signal);
      requireValue(page.mime === 'text/html', 'X public page did not return HTML');
      html = new TextDecoder('utf-8', { fatal: true }).decode(page.bytes);
      supportingPage = { url: page.url, sha256: hash(page.bytes) };
      files.push({ name: 'x-original-page.html.txt', mime: 'text/plain', bytes: page.bytes, url: page.url, operation: 'import_original', active: false });
      if (hasVideoMetadata(html)) { complete = false; warnings.push('This X post includes video; the importer supports only text and static images.'); }
    } catch (error) { if (expectsXImage) warnings.push(`X public image metadata unavailable: ${error.message}`); }
  } else if (received.mime === 'text/html') {
    html = new TextDecoder('utf-8', { fatal: true }).decode(received.bytes); text = htmlText(html);
    title = (htmlTitle(html) || original.hostname).slice(0, 120);
    files.push({ name: 'original-page.html.txt', mime: 'text/plain', bytes: received.bytes, url: received.url, operation: 'import_original' });
  } else if (received.mime === 'text/plain') {
    new TextDecoder('utf-8', { fatal: true }).decode(received.bytes);
    files.push({ name: 'source-text.txt', mime: 'text/plain', bytes: received.bytes, url: received.url, operation: 'import_original' });
  }
  else if (Object.hasOwn(imageTypes, received.mime)) files.push(await imageFile(received.bytes, received.mime, `source-image.${imageTypes[received.mime]}`, received.url));
  else throw Object.assign(new Error(`Unsupported source type: ${received.mime || 'missing Content-Type'}`), { status: 422 });
  if (text) files.push({ name: 'source-text.txt', mime: 'text/plain', bytes: Buffer.from(text), url: original.href, operation: 'import_text' });
  const linkedImages = images(html, isX ? original.href : received.url, isX);
  if (linkedImages.length > 4) { complete = false; warnings.push('Only the first four linked images were imported. Additional source images may be needed.'); }
  for (const imageURL of linkedImages.slice(0, 4)) {
    try {
      const image = await fetchSource(imageURL, 0, signal);
      files.push(await imageFile(image.bytes, image.mime, `source-image-${files.length}.${imageTypes[image.mime]}`, image.url));
    } catch (error) { complete = false; warnings.push(`Image unavailable: ${imageURL} (${error.message})`); }
  }
  if (isX && expectsXImage && !files.some(f => f.mime === 'image/png')) { complete = false; warnings.push('The X post text was saved, but its original image is unavailable. The image is needed before an image-based puzzle can be investigated.'); }
  requireValue(files.length, 'Source did not contain readable text or a supported image', 422);
  for (const file of files) await validateFile(file.bytes, file.mime);
  return { title: title || original.hostname, files, source: { kind: 'url', url: original.href, final_url: isX ? original.href : received.url, transport_url: received.url,
    fetched_at: new Date().toISOString(), sha256: hash(received.bytes), complete, warnings, supporting_page: supportingPage, method: isX ? supportingPage ? 'x_public_page_and_oembed' : 'x_public_oembed' : 'public_https' } };
}
