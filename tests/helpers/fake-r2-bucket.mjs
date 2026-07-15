function cloneMetadata(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bodyStream(bytes, counters) {
  return new ReadableStream({
    start(controller) {
      counters.streamStarts += 1;
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function objectMetadata(key, record, range = undefined) {
  return {
    key,
    version: 'fake-version',
    size: record.bytes.byteLength,
    etag: record.etag,
    httpEtag: `"${record.etag}"`,
    uploaded: new Date('2026-07-12T00:00:00.000Z'),
    httpMetadata: cloneMetadata(record.httpMetadata),
    customMetadata: cloneMetadata(record.customMetadata),
    checksums: {},
    ...(range ? { range } : {}),
    writeHttpMetadata(headers) {
      if (record.httpMetadata?.contentType) {
        headers.set('Content-Type', record.httpMetadata.contentType);
      }
    },
  };
}

export function createFakeR2Bucket(initialObjects) {
  const records = new Map();
  for (const [key, value] of Object.entries(initialObjects)) {
    records.set(key, {
      bytes: Uint8Array.from(value.bytes),
      etag: value.etag,
      customMetadata: cloneMetadata(value.customMetadata),
      httpMetadata: cloneMetadata(value.httpMetadata),
    });
  }
  const calls = [];
  const counters = { streamStarts: 0 };

  return {
    calls,
    counters,
    records,
    async head(key) {
      calls.push({ operation: 'head', key });
      const record = records.get(key);
      return record ? objectMetadata(key, record) : null;
    },
    async get(key, options = {}) {
      calls.push({ operation: 'get', key, options: structuredClone(options) });
      const record = records.get(key);
      if (!record) return null;
      const range = options.range;
      const offset = range?.offset ?? 0;
      const length = range?.length ?? record.bytes.byteLength;
      const selected = record.bytes.slice(offset, offset + length);
      return {
        ...objectMetadata(key, record, range ? { offset, length: selected.byteLength } : undefined),
        body: bodyStream(selected, counters),
      };
    },
  };
}
