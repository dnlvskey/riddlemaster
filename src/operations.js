import sharp from 'sharp';

export const operations = ['base64', 'hex', 'caesar', 'morse', 'xor', 'png_channel', 'invert', 'contrast'];
const morse = Object.fromEntries('A .-;B -...;C -.-.;D -..;E .;F ..-.;G --.;H ....;I ..;J .---;K -.-;L .-..;M --;N -.;O ---;P .--.;Q --.-;R .-.;S ...;T -;U ..-;V ...-;W .--;X -..-;Y -.--;Z --..;0 -----;1 .----;2 ..---;3 ...--;4 ....-;5 .....;6 -....;7 --...;8 ---..;9 ----.'.split(';').map(s => s.split(' ').reverse()));
export function requireValue(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
export function shortText(value, label, max = 4000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} must contain 1–${max} characters`);
  return value.trim();
}
export function validBase64(text) {
  const end = text.length - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  return text.length > 0 && text.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(text.slice(0, end));
}
export async function validateFile(buffer, mime) {
  requireValue(buffer.length > 0 && buffer.length <= 4 * 1024 * 1024, 'File must contain 1 byte–4 MB');
  requireValue(['text/plain', 'image/png'].includes(mime), 'Only TXT and PNG are supported');
  if (mime === 'image/png') {
    const meta = await sharp(buffer, { limitInputPixels: 10_000_000 }).metadata();
    requireValue(meta.format === 'png' && (meta.pages ?? 1) === 1, 'Upload one PNG image');
  } else new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}
function hexBytes(text) {
  const clean = text.replace(/\s/g, '');
  requireValue(clean.length > 0 && clean.length % 2 === 0 && /^[\da-f]+$/i.test(clean), 'Expected complete hexadecimal byte pairs');
  return Buffer.from(clean, 'hex');
}
export async function transform(buffer, mime, operation, params = {}) {
  requireValue(operations.includes(operation), 'Unknown operation');
  if (['png_channel', 'invert', 'contrast'].includes(operation)) {
    requireValue(mime === 'image/png', 'This operation needs a PNG');
    let img = sharp(buffer, { limitInputPixels: 10_000_000 });
    if (operation === 'png_channel') {
      requireValue(['red', 'green', 'blue', 'alpha'].includes(params.channel), 'Choose red, green, blue or alpha');
      if (params.channel === 'alpha') img = img.ensureAlpha();
      img = sharp(await img.extractChannel(params.channel).png().toBuffer());
      if (params.normalize !== false) {
        const { min, max } = (await img.stats()).channels[0];
        if (max > min) img = img.linear(255 / (max - min), -min * 255 / (max - min));
      }
    } else if (operation === 'invert') img = img.negate({ alpha: false });
    else {
      const factor = Number(params.factor ?? 4);
      requireValue(Number.isFinite(factor) && factor >= 0.1 && factor <= 32, 'Contrast factor must be 0.1–32');
      img = img.linear(factor, 128 * (1 - factor));
    }
    return { buffer: await img.png().toBuffer(), mime: 'image/png' };
  }
  requireValue(mime === 'text/plain', 'This operation needs TXT');
  const text = buffer.toString('utf8');
  let output;
  if (operation === 'base64') {
    const clean = text.replace(/\s/g, '');
    requireValue(validBase64(clean), 'Expected padded Base64');
    output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(clean, 'base64'));
  } else if (operation === 'hex') output = new TextDecoder('utf-8', { fatal: true }).decode(hexBytes(text));
  else if (operation === 'caesar') {
    const shift = Number(params.shift);
    requireValue(Number.isInteger(shift) && shift >= -25 && shift <= 25, 'Caesar shift must be an integer from -25 to 25');
    output = text.replace(/[A-Za-z]/g, c => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(base + (c.charCodeAt(0) - base + shift + 26) % 26);
    });
  } else if (operation === 'morse') {
    output = text.trim().split('/').map(word => word.trim().split(/\s+/).map(code => {
      requireValue(Boolean(morse[code]), `Unknown Morse symbol: ${code}`);
      return morse[code];
    }).join('')).join(' ');
  } else {
    const key = Buffer.from(shortText(params.key, 'XOR key', 128), 'utf8');
    const bytes = params.input_format === 'text' ? buffer : hexBytes(text);
    const decoded = Buffer.from(bytes.map((byte, i) => byte ^ key[i % key.length]));
    output = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  }
  return { buffer: Buffer.from(output, 'utf8'), mime: 'text/plain' };
}
