/**
 * Image header sniffing: dimensions + format for the screenshot API.
 *
 * The legacy screenshot handler relied on a browser-only canvas pipeline to
 * learn width/height. Reading the container header works identically in a
 * service worker, in Node and in tests, at a fraction of the cost.
 */
'use strict';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode the first `count` bytes of a base64 string without depending on Buffer. */
function decodeBase64Head(base64, count) {
  const clean = String(base64 || '').replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const byteCount = Math.min(count, Math.floor(clean.length * 3 / 4));
  const out = new Uint8Array(byteCount);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < clean.length && index < byteCount; i++) {
    const char = clean.charAt(i);
    if (char === '=') break;
    const value = BASE64_CHARS.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

function base64ByteLength(base64) {
  const clean = String(base64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function readPng(bytes) {
  // signature(8) + IHDR length(4) + "IHDR"(4) + width(4) + height(4)
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

function readGif(bytes) {
  if (bytes.length < 10) return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return { format: 'gif', width: width, height: height };
}

function readWebp(bytes) {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit dimensions.
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return { format: 'webp', width: width, height: height };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit width-1 / height-1 packed after the 0x2f signature.
    const bits = view.getUint32(21, true);
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { format: 'webp', width: width, height: height };
  }
  return null;
}

function readJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 excluding DHT(0xc4), JPGA(0xc8), DAC(0xcc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return { format: 'jpeg', width: width, height: height };
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength <= 0) break;
    offset += 2 + segmentLength;
  }
  return null;
}

/**
 * @param {string|Uint8Array} input base64 data URL / raw base64 / bytes
 * @returns {{format: string, width: number, height: number}|null}
 */
function sniffImage(input) {
  if (input === null || input === undefined) return null;
  const isBytes = input instanceof Uint8Array;

  // Sniff on the first 64 bytes, then decode just enough for the container.
  const head = isBytes ? input : decodeBase64Head(input, 64);
  if (!head || head.length < 4) return null;

  const slice = (count) => (isBytes ? input : decodeBase64Head(input, count));

  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return readPng(head.length >= 24 ? head : slice(32));
  }
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return readGif(head);
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    // The SOF segment can sit behind arbitrarily long metadata segments.
    return readJpeg(head.length >= 512 ? head : slice(4096));
  }
  if (head.length >= 16) {
    const riff = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const webp = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (riff === 'RIFF' && webp === 'WEBP') return readWebp(head);
  }
  return null;
}

module.exports = { sniffImage, base64ByteLength, decodeBase64Head };
