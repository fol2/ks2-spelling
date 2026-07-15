import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const SOURCE = new URL('tests/fixtures/b3-hostile-zips/', ROOT);
const NATIVE = new URL('android/app/src/test/resources/b3-hostile-zips/', ROOT);

test('Android JVM resources are an exact full hostile-corpus byte mirror', async () => {
  const sourceManifest = await readFile(new URL('manifest.json', SOURCE));
  const nativeManifest = await readFile(new URL('manifest.json', NATIVE));
  assert.deepEqual(nativeManifest, sourceManifest);
  const manifest = JSON.parse(sourceManifest);
  assert.equal(manifest.fixtures.length, 53);
  for (const fixture of manifest.fixtures) {
    const [source, native] = await Promise.all([
      readFile(new URL(fixture.file, SOURCE)),
      readFile(new URL(fixture.file, NATIVE)),
    ]);
    assert.deepEqual(native, source, fixture.category);
    assert.equal(createHash('sha256').update(native).digest('hex'), fixture.sha256);
    assert.equal(native.length, fixture.bytes);
  }
  const [proof, envelope] = await Promise.all([
    readFile(new URL('android/app/src/test/resources/b3-sandbox-proof.zip', ROOT)),
    readFile(new URL('android/app/src/test/resources/b3-signed-manifest.json', ROOT)),
  ]);
  assert.equal(createHash('sha256').update(proof).digest('hex'), '4c2ca2eb4d4bb7ac3347b66e3483dcb6aa71b41958704733bfc471c970ce7664');
  assert.deepEqual(envelope, await readFile(new URL('tests/fixtures/b3-signed-manifest.json', ROOT)));
});
