import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const BIT_DEPTHS = Object.freeze({
  0: Object.freeze([1, 2, 4, 8, 16]),
  2: Object.freeze([8, 16]),
  3: Object.freeze([1, 2, 4, 8]),
  4: Object.freeze([8, 16]),
  6: Object.freeze([8, 16]),
});

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
}));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function validateB3PngBytes(rawBytes, {
  minimumWidth = 320,
  minimumHeight = 480,
  maximumBytes = 64 * 1024 * 1024,
  maximumWidth = 8_192,
  maximumHeight = 8_192,
  maximumPixels = 32 * 1024 * 1024,
  maximumInflatedBytes = 128 * 1024 * 1024,
  label = 'B3 screenshot',
} = {}) {
  const bytes = rawBytes instanceof Uint8Array ? Buffer.from(rawBytes) : null;
  const fail = () => { throw new Error(`${label} is not a complete bounded PNG`); };
  if (!bytes || bytes.length < 57 || bytes.length > maximumBytes ||
      !bytes.subarray(0, 8).equals(SIGNATURE)) fail();
  let offset = 8;
  let width;
  let height;
  let rowBytes;
  let sawIhdr = false;
  let sawIend = false;
  const idat = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/u.test(type) ||
        crc32(Buffer.concat([typeBytes, data])) !== bytes.readUInt32BE(offset + 8 + length)) fail();
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) fail();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      if (width < minimumWidth || height < minimumHeight ||
          width > maximumWidth || height > maximumHeight ||
          width * height > maximumPixels ||
          !Object.hasOwn(CHANNELS, colourType) || !BIT_DEPTHS[colourType].includes(bitDepth) ||
          data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail();
      rowBytes = Math.ceil(width * CHANNELS[colourType] * bitDepth / 8);
      sawIhdr = true;
    } else if (type === 'IHDR') fail();
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') {
      if (length !== 0 || idat.length === 0 || end !== bytes.length) fail();
      sawIend = true;
    }
    if (sawIend && end !== bytes.length) fail();
    offset = end;
  }
  if (!sawIhdr || !sawIend || offset !== bytes.length) fail();
  const expectedInflated = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(expectedInflated) || expectedInflated > maximumInflatedBytes) fail();
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedInflated });
  } catch {
    fail();
  }
  if (inflated.length !== expectedInflated) fail();
  for (let row = 0; row < height; row += 1) {
    if (inflated[row * (rowBytes + 1)] > 4) fail();
  }
  return Object.freeze({
    bytes,
    width,
    height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
