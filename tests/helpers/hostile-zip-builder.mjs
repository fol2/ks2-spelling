import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const REGULAR_MODE = 0o100644;
const COMPRESSED_CEILING = 1_048_576;
const EXTRACTED_CEILING = 4_194_304;
const FILE_COUNT_CEILING = 16;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function buffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function entry(input = {}) {
  const name = input.name ?? 'catalogue.json';
  const data = buffer(input.data ?? '{"proof":true}\n');
  const nameBytes = buffer(name);
  const localName = buffer(input.localName ?? nameBytes);
  const centralName = buffer(input.centralName ?? nameBytes);
  const localExtra = buffer(input.localExtra ?? Buffer.alloc(0));
  const centralExtra = buffer(input.centralExtra ?? Buffer.alloc(0));
  const compressedData = input.compressedData === undefined
    ? (input.localMethod === 8 || input.centralMethod === 8 ? deflateRawSync(data) : data)
    : buffer(input.compressedData);
  const checksum = crc32(data);
  return {
    name,
    data,
    compressedData,
    localName,
    centralName,
    localExtra,
    centralExtra,
    versionMadeBy: input.versionMadeBy ?? 0x0314,
    versionNeeded: input.versionNeeded ?? 20,
    localFlags: input.localFlags ?? UTF8_FLAG,
    centralFlags: input.centralFlags ?? UTF8_FLAG,
    localMethod: input.localMethod ?? 0,
    centralMethod: input.centralMethod ?? 0,
    localCrc: input.localCrc ?? checksum,
    centralCrc: input.centralCrc ?? checksum,
    localCompressedBytes: input.localCompressedBytes ?? compressedData.length,
    centralCompressedBytes: input.centralCompressedBytes ?? compressedData.length,
    localExtractedBytes: input.localExtractedBytes ?? data.length,
    centralExtractedBytes: input.centralExtractedBytes ?? data.length,
    mode: input.mode ?? REGULAR_MODE,
    externalAttributes: input.externalAttributes,
    localOffset: input.localOffset,
    diskStart: input.diskStart ?? 0,
    comment: buffer(input.comment ?? Buffer.alloc(0)),
    includeLocal: input.includeLocal ?? true,
  };
}

function localRecord(item) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(item.versionNeeded, 4);
  header.writeUInt16LE(item.localFlags, 6);
  header.writeUInt16LE(item.localMethod, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x5c2c, 12);
  header.writeUInt32LE(item.localCrc >>> 0, 14);
  header.writeUInt32LE(item.localCompressedBytes >>> 0, 18);
  header.writeUInt32LE(item.localExtractedBytes >>> 0, 22);
  header.writeUInt16LE(item.localName.length, 26);
  header.writeUInt16LE(item.localExtra.length, 28);
  return Buffer.concat([header, item.localName, item.localExtra, item.compressedData]);
}

function unixExtraField(linkTarget) {
  const target = buffer(linkTarget);
  const field = Buffer.alloc(4 + 12 + target.length);
  field.writeUInt16LE(0x000d, 0);
  field.writeUInt16LE(12 + target.length, 2);
  target.copy(field, 16);
  return field;
}

function buildLocalRecordOverlapOnlyZip() {
  const nested = entry({ name: 'nested-local.json', data: 'two' });
  const nestedLocal = localRecord(nested);
  const firstName = Buffer.from('outer-local.json');
  const prefix = Buffer.from('nested-header:');
  // The outer member ends part-way through the nested header. This overlaps
  // local-record ranges without also overlapping the two member-data ranges.
  const sharedHeaderBytes = 16;
  const firstData = Buffer.concat([prefix, nestedLocal.subarray(0, sharedHeaderBytes)]);
  const first = entry({ name: firstName, data: firstData });
  const firstLocal = localRecord(first);
  const nestedOffset = 30 + firstName.length + prefix.length;
  const suffix = nestedLocal.subarray(sharedHeaderBytes);
  const centralOffset = firstLocal.length + suffix.length;
  const central = Buffer.concat([
    centralRecord(first, 0),
    centralRecord(nested, nestedOffset),
  ]);
  return Buffer.concat([
    firstLocal,
    suffix,
    central,
    eocd({ entryCount: 2, centralSize: central.length, centralOffset }),
  ]);
}

function buildNestedDataRangeZip() {
  const firstName = 'outer-data.json';
  const secondName = 'nested-data.json';
  const prefix = 'overlapping-data:';
  // Data overlap necessarily also overlaps record ranges because member data
  // is contained by its local record; the measured data ranges are the
  // independent invariant for this fixture.
  const nested = entry({ name: secondName, data: 'two' });
  const nestedLocal = localRecord(nested);
  const firstNameBytes = Buffer.from(firstName);
  const prefixBytes = Buffer.from(prefix);
  const firstData = Buffer.concat([prefixBytes, nestedLocal]);
  const first = entry({ name: firstNameBytes, data: firstData });
  const firstLocal = localRecord(first);
  const nestedOffset = 30 + firstNameBytes.length + prefixBytes.length;
  const centralOffset = firstLocal.length;
  const central = Buffer.concat([
    centralRecord(first, 0),
    centralRecord(nested, nestedOffset),
  ]);
  return Buffer.concat([
    firstLocal,
    central,
    eocd({ entryCount: 2, centralSize: central.length, centralOffset }),
  ]);
}

function solveCrc32FixedPoint(createBytes) {
  const base = crc32(createBytes(0));
  const columns = Array.from({ length: 32 }, (_, bit) =>
    (crc32(createBytes((2 ** bit) >>> 0)) ^ base) >>> 0);
  const rows = Array.from({ length: 32 }, (_, outputBit) => {
    let row = 0n;
    for (let inputBit = 0; inputBit < 32; inputBit += 1) {
      if (((columns[inputBit] >>> outputBit) & 1) === 1) {
        row |= 1n << BigInt(inputBit);
      }
    }
    row ^= 1n << BigInt(outputBit);
    if (((base >>> outputBit) & 1) === 1) row |= 1n << 32n;
    return row;
  });
  let pivotRow = 0;
  const pivotColumns = [];
  for (let column = 0; column < 32; column += 1) {
    const mask = 1n << BigInt(column);
    const found = rows.findIndex((row, index) => index >= pivotRow && (row & mask) !== 0n);
    if (found < 0) continue;
    [rows[pivotRow], rows[found]] = [rows[found], rows[pivotRow]];
    for (let index = 0; index < rows.length; index += 1) {
      if (index !== pivotRow && (rows[index] & mask) !== 0n) rows[index] ^= rows[pivotRow];
    }
    pivotColumns[pivotRow] = column;
    pivotRow += 1;
  }
  if (pivotRow !== 32) throw new Error('central-overlap CRC fixed point is not unique');
  let solution = 0;
  for (let index = 0; index < 32; index += 1) {
    if ((rows[index] & (1n << 32n)) !== 0n) solution += 2 ** pivotColumns[index];
  }
  const checksum = solution >>> 0;
  if (crc32(createBytes(checksum)) !== checksum) {
    throw new Error('central-overlap CRC fixed point is invalid');
  }
  return checksum;
}

function buildCentralDirectoryOverlapZip() {
  const name = Buffer.from('central-overlap.json');
  const prefix = Buffer.from('central-inside-data:');
  const dataBytes = prefix.length + 46 + name.length;
  const createData = (checksum) => {
    const item = entry({
      name,
      data: Buffer.alloc(dataBytes),
      localCrc: checksum,
      centralCrc: checksum,
    });
    return Buffer.concat([prefix, centralRecord(item, 0)]);
  };
  // The central record contains its own CRC field while also forming part of
  // the stored member bytes. Solve the fixed point so CRC parity stays valid
  // and overlap is the only rejection reason.
  const checksum = solveCrc32FixedPoint(createData);
  const data = createData(checksum);
  const item = entry({ name, data, localCrc: checksum, centralCrc: checksum });
  const local = localRecord(item);
  const centralOffset = 30 + name.length + prefix.length;
  const centralSize = 46 + name.length;
  return Buffer.concat([
    local,
    eocd({ entryCount: 1, centralSize, centralOffset }),
  ]);
}

function centralRecord(item, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(item.versionMadeBy, 4);
  header.writeUInt16LE(item.versionNeeded, 6);
  header.writeUInt16LE(item.centralFlags, 8);
  header.writeUInt16LE(item.centralMethod, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x5c2c, 14);
  header.writeUInt32LE(item.centralCrc >>> 0, 16);
  header.writeUInt32LE(item.centralCompressedBytes >>> 0, 20);
  header.writeUInt32LE(item.centralExtractedBytes >>> 0, 24);
  header.writeUInt16LE(item.centralName.length, 28);
  header.writeUInt16LE(item.centralExtra.length, 30);
  header.writeUInt16LE(item.comment.length, 32);
  header.writeUInt16LE(item.diskStart, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(
    item.externalAttributes ?? ((item.mode & 0xffff) << 16) >>> 0,
    38,
  );
  header.writeUInt32LE((item.localOffset ?? localOffset) >>> 0, 42);
  return Buffer.concat([header, item.centralName, item.centralExtra, item.comment]);
}

function eocd({ entryCount, centralSize, centralOffset, comment = Buffer.alloc(0) }) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(EOCD_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize >>> 0, 12);
  record.writeUInt32LE(centralOffset >>> 0, 16);
  record.writeUInt16LE(comment.length, 20);
  return Buffer.concat([record, comment]);
}

export function buildDeterministicZip(inputEntries, options = {}) {
  const entries = inputEntries.map((item) => entry(item));
  const prefix = buffer(options.prefix ?? Buffer.alloc(0));
  const localRecords = [];
  const calculatedOffsets = [];
  let localLength = prefix.length;
  for (const item of entries) {
    calculatedOffsets.push(localLength);
    if (item.includeLocal) {
      const record = localRecord(item);
      localRecords.push(record);
      localLength += record.length;
    }
  }
  const centralOffset = options.centralOffset ?? localLength;
  const centralRecords = entries.map((item, index) =>
    centralRecord(item, calculatedOffsets[index]));
  const central = Buffer.concat(centralRecords);
  const end = eocd({
    entryCount: options.entryCount ?? entries.length,
    centralSize: options.centralSize ?? central.length,
    centralOffset,
    comment: buffer(options.eocdComment ?? Buffer.alloc(0)),
  });
  return Buffer.concat([
    prefix,
    ...localRecords,
    central,
    end,
    buffer(options.trailing ?? Buffer.alloc(0)),
  ]);
}

function baseFor(category, overrides = {}) {
  return buildDeterministicZip([
    { name: `${category}.json`, data: `{"category":"${category}"}\n`, ...overrides },
  ]);
}

export const HOSTILE_ZIP_CATEGORIES = Object.freeze([
  'traversal-path', 'absolute-path', 'drive-path', 'backslash-path',
  'dot-segment', 'empty-segment', 'duplicate-path', 'case-fold-collision',
  'unicode-nfc-collision', 'creator-os-zero', 'creator-os-unknown',
  'mode-zero', 'mode-ambiguous', 'symlink-mode', 'hard-link-mode',
  'device-mode', 'fifo-mode', 'socket-mode', 'directory-mode',
  'local-name-mismatch', 'local-flag-mismatch', 'local-method-mismatch',
  'local-crc-mismatch', 'local-size-mismatch', 'duplicate-local-offset',
  'overlapping-local-offset', 'overlapping-data-range', 'central-directory-overlap',
  'truncated-offset', 'overflowing-offset', 'truncated-size', 'overflowing-size',
  'multiple-eocd', 'ambiguous-eocd', 'eocd-not-at-eof', 'prepended-junk',
  'trailing-junk', 'non-zero-extra-field', 'unknown-extra-field',
  'encrypted-flag', 'unknown-flag', 'unknown-compression-method',
  'member-comment', 'multi-disk', 'data-descriptor', 'zip64',
  'local-extracted-size-mismatch', 'undeclared-member', 'missing-member',
  'executable-extension', 'compressed-ceiling', 'extracted-ceiling',
  'file-count-ceiling',
]);

export function buildHostileZip(category) {
  switch (category) {
    case 'traversal-path': return baseFor(category, { name: '../catalogue.json' });
    case 'absolute-path': return baseFor(category, { name: '/catalogue.json' });
    case 'drive-path': return baseFor(category, { name: 'C:/catalogue.json' });
    case 'backslash-path': return baseFor(category, { name: 'audio\\proof.m4a' });
    case 'dot-segment': return baseFor(category, { name: 'audio/./proof.m4a' });
    case 'empty-segment': return baseFor(category, { name: 'audio//proof.m4a' });
    case 'duplicate-path': return buildDeterministicZip([
      { name: 'catalogue.json', data: 'one' }, { name: 'catalogue.json', data: 'two' },
    ]);
    case 'case-fold-collision': return buildDeterministicZip([
      { name: 'Audio/proof.m4a', data: 'one' }, { name: 'audio/proof.m4a', data: 'two' },
    ]);
    case 'unicode-nfc-collision': return buildDeterministicZip([
      { name: 'audio/caf\u00e9.m4a', data: 'one' },
      { name: 'audio/cafe\u0301.m4a', data: 'two' },
    ]);
    case 'creator-os-zero': return baseFor(category, { versionMadeBy: 0x0014 });
    case 'creator-os-unknown': return baseFor(category, { versionMadeBy: 0x6314 });
    case 'mode-zero': return baseFor(category, { mode: 0 });
    case 'mode-ambiguous': return baseFor(category, { mode: 0o170644 });
    case 'symlink-mode': return baseFor(category, { mode: 0o120777 });
    case 'hard-link-mode': {
      const hardLinkExtra = unixExtraField('catalogue.json');
      return baseFor(category, {
        mode: REGULAR_MODE,
        localExtra: hardLinkExtra,
        centralExtra: hardLinkExtra,
      });
    }
    case 'device-mode': return baseFor(category, { mode: 0o060644 });
    case 'fifo-mode': return baseFor(category, { mode: 0o010644 });
    case 'socket-mode': return baseFor(category, { mode: 0o140644 });
    case 'directory-mode': return baseFor(category, { mode: 0o040755, name: 'audio/' });
    case 'local-name-mismatch': return baseFor(category, {
      name: 'catalogue.json', localName: 'catalogue.JSON', centralName: 'catalogue.json',
    });
    case 'local-flag-mismatch': return baseFor(category, { localFlags: 0 });
    case 'local-method-mismatch': return baseFor(category, { localMethod: 8 });
    case 'local-crc-mismatch': return baseFor(category, { localCrc: 1 });
    case 'local-size-mismatch': return baseFor(category, { localCompressedBytes: 1 });
    case 'duplicate-local-offset': return buildDeterministicZip([
      { name: 'one.json', data: 'one' }, { name: 'two.json', data: 'two', localOffset: 0 },
    ]);
    case 'overlapping-local-offset': return buildLocalRecordOverlapOnlyZip();
    case 'overlapping-data-range': return buildNestedDataRangeZip();
    case 'central-directory-overlap': return buildCentralDirectoryOverlapZip();
    case 'truncated-offset': return baseFor(category, { localOffset: 0x00ffffff });
    case 'overflowing-offset': return baseFor(category, { localOffset: 0xffffffff });
    case 'truncated-size': return baseFor(category, {
      localCompressedBytes: 0x00ffffff, centralCompressedBytes: 0x00ffffff,
    });
    case 'overflowing-size': return baseFor(category, {
      localCompressedBytes: 0xffffffff, centralCompressedBytes: 0xffffffff,
    });
    case 'multiple-eocd': {
      const bytes = baseFor(category);
      return Buffer.concat([bytes, bytes.subarray(bytes.length - 22)]);
    }
    case 'ambiguous-eocd': {
      const fake = Buffer.alloc(22);
      fake.writeUInt32LE(EOCD_SIGNATURE, 0);
      return buildDeterministicZip([
        { name: `${category}.json`, data: 'ambiguous' },
      ], { eocdComment: fake });
    }
    case 'eocd-not-at-eof': return buildDeterministicZip([
      { name: `${category}.json`, data: category },
    ], { trailing: 'x' });
    case 'prepended-junk': return buildDeterministicZip([
      { name: `${category}.json`, data: category },
    ], { prefix: 'JUNK' });
    case 'trailing-junk': return buildDeterministicZip([
      { name: `${category}.json`, data: category },
    ], { trailing: 'TRAILING-JUNK' });
    case 'non-zero-extra-field': return baseFor(category, {
      localExtra: Buffer.from([0xfe, 0xca, 0, 0]), centralExtra: Buffer.from([0xfe, 0xca, 0, 0]),
    });
    case 'unknown-extra-field': return baseFor(category, {
      localExtra: Buffer.from([0x37, 0x13, 1, 0, 0]),
      centralExtra: Buffer.from([0x37, 0x13, 1, 0, 0]),
    });
    case 'encrypted-flag': return baseFor(category, {
      localFlags: UTF8_FLAG | 0x0001, centralFlags: UTF8_FLAG | 0x0001,
    });
    case 'unknown-flag': return baseFor(category, {
      localFlags: UTF8_FLAG | 0x4000, centralFlags: UTF8_FLAG | 0x4000,
    });
    case 'unknown-compression-method': return baseFor(category, {
      localMethod: 99, centralMethod: 99,
    });
    case 'member-comment': return baseFor(category, { comment: 'forbidden' });
    case 'multi-disk': return baseFor(category, { diskStart: 1 });
    case 'data-descriptor': return baseFor(category, {
      localFlags: UTF8_FLAG | 0x0008, centralFlags: UTF8_FLAG | 0x0008,
    });
    case 'zip64': return baseFor(category, {
      versionNeeded: 45,
      localExtra: Buffer.from([1, 0, 0, 0]), centralExtra: Buffer.from([1, 0, 0, 0]),
    });
    case 'local-extracted-size-mismatch': return baseFor(category, {
      localExtractedBytes: 1,
    });
    case 'undeclared-member': return buildDeterministicZip([
      { name: 'catalogue.json', data: '{}' }, { name: 'undeclared.json', data: '{}' },
    ]);
    case 'missing-member': return buildDeterministicZip([
      { name: 'catalogue.json', data: '{}' },
    ]);
    case 'executable-extension': return baseFor(category, { name: 'payload.js' });
    case 'compressed-ceiling': return baseFor(category, {
      data: Buffer.alloc(COMPRESSED_CEILING + 1, 0x61),
    });
    case 'extracted-ceiling': return baseFor(category, {
      data: Buffer.alloc(EXTRACTED_CEILING + 1, 0x62),
      localMethod: 8,
      centralMethod: 8,
    });
    case 'file-count-ceiling': return buildDeterministicZip(
      Array.from({ length: FILE_COUNT_CEILING + 1 }, (_, index) => ({
        name: `files/${String(index).padStart(2, '0')}.json`, data: `${index}`,
      })),
    );
    default: throw new TypeError(`Unknown hostile ZIP category: ${category}`);
  }
}

function centralEntries(bytes) {
  const endOffset = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary'));
  if (endOffset < 0 || endOffset + 22 > bytes.length) throw new Error('missing EOCD');
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('bad central entry');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const extractedBytes = bytes.readUInt32LE(cursor + 24);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedBytes;
    entries.push({
      cursor, localOffset, compressedBytes, extractedBytes, dataStart, dataEnd,
      name: bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      flags: bytes.readUInt16LE(cursor + 8),
      crc: bytes.readUInt32LE(cursor + 16),
      mode: bytes.readUInt32LE(cursor + 38) >>> 16,
      centralExtra: bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength),
      method: bytes.readUInt16LE(cursor + 10),
      localName: bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      localFlags: bytes.readUInt16LE(localOffset + 6),
      localMethod: bytes.readUInt16LE(localOffset + 8),
      localCrc: bytes.readUInt32LE(localOffset + 14),
      localCompressedBytes: bytes.readUInt32LE(localOffset + 18),
      localExtractedBytes: bytes.readUInt32LE(localOffset + 22),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return {
    entries,
    centralOffset,
    centralSize: bytes.readUInt32LE(endOffset + 12),
    endOffset,
    parsedCentralEnd: cursor,
  };
}

function assertSemanticallyValidEntries(bytes, entries, label) {
  for (const item of entries) {
    if (bytes.readUInt32LE(item.localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`${label} local header is not parseable`);
    }
    const compressed = bytes.subarray(item.dataStart, item.dataEnd);
    const extracted = item.method === 8 ? inflateRawSync(compressed) : compressed;
    if (
      !item.name.equals(item.localName) ||
      item.flags !== item.localFlags ||
      item.method !== item.localMethod ||
      item.crc !== item.localCrc ||
      item.compressedBytes !== item.localCompressedBytes ||
      item.extractedBytes !== item.localExtractedBytes ||
      extracted.length !== item.extractedBytes ||
      crc32(extracted) !== item.crc
    ) throw new Error(`${label} is not a semantically valid ZIP member`);
  }
}

export function assertHostileZipPrecondition(category, bytes) {
  switch (category) {
    case 'hard-link-mode': {
      const { entries } = centralEntries(bytes);
      const [item] = entries;
      if (item.mode !== REGULAR_MODE || item.centralExtra.readUInt16LE(0) !== 0x000d) {
        throw new Error('hard-link fixture is not a Unix 0x000d regular-mode link target');
      }
      const target = item.centralExtra.subarray(16).toString('utf8');
      if (target !== 'catalogue.json') throw new Error('hard-link target is absent');
      break;
    }
    case 'overlapping-local-offset': {
      const { entries, centralOffset } = centralEntries(bytes);
      const [outer, nested] = entries;
      if (
        entries.length !== 2 ||
        outer.localOffset === nested.localOffset ||
        bytes.readUInt32LE(outer.localOffset) !== LOCAL_SIGNATURE ||
        bytes.readUInt32LE(nested.localOffset) !== LOCAL_SIGNATURE ||
        !(nested.localOffset > outer.localOffset && nested.localOffset < outer.dataEnd) ||
        outer.dataEnd > nested.dataStart ||
        outer.dataEnd > centralOffset || nested.dataEnd > centralOffset
      ) throw new Error('fixture has no bounded nested local-record range');
      assertSemanticallyValidEntries(bytes, entries, 'nested local-record entry');
      break;
    }
    case 'overlapping-data-range': {
      const { entries, centralOffset } = centralEntries(bytes);
      const [left, right] = entries;
      if (
        !(left.dataStart < right.dataEnd && right.dataStart < left.dataEnd) ||
        left.dataEnd > centralOffset || right.dataEnd > centralOffset
      ) throw new Error('fixture has no bounded overlapping data ranges');
      assertSemanticallyValidEntries(bytes, entries, 'overlap entry');
      break;
    }
    case 'central-directory-overlap': {
      const {
        entries,
        centralOffset,
        centralSize,
        endOffset,
        parsedCentralEnd,
      } = centralEntries(bytes);
      const [item] = entries;
      if (
        entries.length !== 1 ||
        parsedCentralEnd !== endOffset ||
        centralOffset + centralSize !== endOffset ||
        !(centralOffset >= item.dataStart && centralOffset < item.dataEnd) ||
        item.dataEnd > endOffset
      ) throw new Error('central directory is not parseable and bounded inside member data');
      assertSemanticallyValidEntries(bytes, entries, 'central-overlap entry');
      break;
    }
    case 'compressed-ceiling': {
      const { entries, centralOffset } = centralEntries(bytes);
      const [item] = entries;
      if (item.compressedBytes <= COMPRESSED_CEILING || item.dataEnd > centralOffset) {
        throw new Error('compressed ceiling is not exceeded by actual member bytes');
      }
      break;
    }
    case 'extracted-ceiling': {
      const { entries } = centralEntries(bytes);
      const [item] = entries;
      const extracted = inflateRawSync(bytes.subarray(item.dataStart, item.dataEnd));
      if (extracted.length <= EXTRACTED_CEILING || extracted.length !== item.extractedBytes) {
        throw new Error('extracted ceiling is not exceeded by actual expanded bytes');
      }
      break;
    }
    case 'file-count-ceiling': {
      const { entries } = centralEntries(bytes);
      if (entries.length <= FILE_COUNT_CEILING) throw new Error('file-count ceiling is not exceeded');
      break;
    }
    default:
      break;
  }
}

export function expectedHostileZipRejection(category) {
  if (!HOSTILE_ZIP_CATEGORIES.includes(category)) {
    throw new TypeError(`Unknown hostile ZIP category: ${category}`);
  }
  switch (category) {
    case 'overlapping-local-offset': return 'overlapping-local-record-range';
    case 'overlapping-data-range': return 'overlapping-member-data-range';
    case 'central-directory-overlap': return 'central-directory-member-overlap';
    default: return category;
  }
}

function corpusError(detail) {
  throw new Error(`Hostile ZIP corpus verification failed: ${detail}.`);
}

function expectedCorpus() {
  const fixtures = HOSTILE_ZIP_CATEGORIES.map((category) => {
    const bytes = buildHostileZip(category);
    return {
      category,
      file: `${category}.zip`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      content: bytes,
    };
  });
  const manifestBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      fixtures: fixtures.map(({ content: _content, ...fixture }) => fixture),
    }, null, 2)}\n`,
  );
  return { fixtures, manifestBytes };
}

export function verifyHostileZipCorpusSnapshot(snapshot) {
  if (!(snapshot instanceof Map)) corpusError('snapshot must be a filename-to-bytes Map');
  const expected = expectedCorpus();
  const expectedNames = ['manifest.json', ...expected.fixtures.map(({ file }) => file)].sort();
  const actualNames = [...snapshot.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    corpusError('extra or missing corpus file');
  }
  for (const fixture of expected.fixtures) {
    const actual = snapshot.get(fixture.file);
    if (!Buffer.isBuffer(actual) || !actual.equals(fixture.content)) {
      corpusError(`${fixture.file} byte regeneration drift`);
    }
    assertHostileZipPrecondition(fixture.category, actual);
  }
  const manifestBytes = snapshot.get('manifest.json');
  if (!Buffer.isBuffer(manifestBytes) || !manifestBytes.equals(expected.manifestBytes)) {
    corpusError('manifest SHA-256 or byte authority drift');
  }
  return Object.freeze({
    fixtureCount: expected.fixtures.length,
    manifestBytes: Buffer.from(manifestBytes),
  });
}

export async function verifyHostileZipCorpus(directory) {
  const absoluteDirectory = resolve(directory);
  let names;
  try {
    names = (await readdir(absoluteDirectory)).sort();
  } catch (error) {
    corpusError(`missing corpus directory (${error.code ?? error.message})`);
  }
  const snapshot = new Map(await Promise.all(names.map(async (name) => [
    name,
    await readFile(resolve(absoluteDirectory, name)),
  ])));
  return verifyHostileZipCorpusSnapshot(snapshot);
}

export async function writeHostileZipCorpus(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const fixtures = [];
  for (const category of HOSTILE_ZIP_CATEGORIES) {
    const file = `${category}.zip`;
    const bytes = buildHostileZip(category);
    await writeFile(resolve(outputDirectory, file), bytes);
    fixtures.push({
      category,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  const manifest = `${JSON.stringify({ schemaVersion: 1, fixtures }, null, 2)}\n`;
  await writeFile(resolve(outputDirectory, 'manifest.json'), manifest);
  return fixtures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outputDirectory, ...extra] = process.argv.slice(2);
  if (!outputDirectory || extra.length > 0) {
    process.stderr.write('Usage: node tests/helpers/hostile-zip-builder.mjs OUTPUT_DIRECTORY\n');
    process.exitCode = 2;
  } else {
    await writeHostileZipCorpus(resolve(outputDirectory));
  }
}
