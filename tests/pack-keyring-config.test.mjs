import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  assertB3ProofPack,
  assertPackKeyring,
} from '../src/domain/commerce/commerce-contracts.js';
import { assertPrivateSigningFixtureExcluded } from './helpers/private-signing-fixture-exclusion.mjs';

const ROOT_URL = new URL('../', import.meta.url);
const PRIVATE_FIXTURE_URL = new URL(
  'tests/fixtures/keys/b3-public-test-vector-p256-private.pem',
  ROOT_URL,
);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, ROOT_URL), 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('the runtime keyring contains only the exact sandbox public key', async () => {
  const keyring = await readJson('config/pack-signing-public-keys.json');

  assert.equal(assertPackKeyring(keyring), keyring);
  assert.deepEqual(keyring, {
    schemaVersion: 1,
    keys: [
      {
        keyId: 'b3-test-p256-2026-07',
        algorithm: 'ECDSA_P256_SHA256_DER',
        publicKeySpkiDerBase64:
          'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYP7UuiVanTHJYet0xjVtaMBJuJI7Yfps5mliLmDyn7Z5A/4QCLi8maQa6elWKLxk8vGyDC1+n1F3o8KU1EYimQ==',
        publicKeySpkiSha256:
          '5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4',
        testOnly: true,
        notBefore: '2026-07-01T00:00:00Z',
        notAfter: '2027-07-01T00:00:00Z',
        allowedEnvironments: ['test', 'sandbox'],
        allowedPackIds: ['b3-sandbox-proof'],
      },
    ],
  });
});

test('the public reproducibility fixture derives the frozen runtime SPKI', async () => {
  const privateFixture = await readFile(PRIVATE_FIXTURE_URL);
  const privateKey = createPrivateKey(privateFixture);
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const keyring = await readJson('config/pack-signing-public-keys.json');

  assert.equal(
    createHash('sha256').update(privateFixture).digest('hex'),
    '930c320433c65f7b500f06ebf5a2a31637b96e84bb1572e551c90054ed1dea49',
  );
  assert.equal(
    createHash('sha256').update(spki).digest('hex'),
    '5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4',
  );
  assert.equal(spki.toString('base64'), keyring.keys[0].publicKeySpkiDerBase64);
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
  assert.equal(
    Buffer.from(publicJwk.x, 'base64url').toString('hex').toUpperCase(),
    '60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6',
  );
  assert.equal(
    Buffer.from(publicJwk.y, 'base64url').toString('hex').toUpperCase(),
    '7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299',
  );
});

function createDeflatedZip(entryName, content) {
  const name = Buffer.from(entryName, 'utf8');
  const compressed = deflateRawSync(content, { level: 9 });
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

test('the public private-half fixture is documented and excluded from runtime', async () => {
  const readme = await readFile(new URL('tests/fixtures/keys/README.md', ROOT_URL), 'utf8');
  assert.match(readme, /public and non-secret/i);
  assert.match(readme, /must never be used as a\s+production signing key/i);

  const result = await assertPrivateSigningFixtureExcluded({
    root: new URL('../', import.meta.url),
  });
  assert.ok(result.filesScanned > 0);
  assert.ok(result.bytesScanned > 0);
  assert.equal(result.authorisedFixtureDirectory, 'tests/fixtures/keys');
});

test('packageable web, native and generated outputs reject private-half leakage', async (t) => {
  const privateKey = createPrivateKey(await readFile(PRIVATE_FIXTURE_URL));
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const scalar = Buffer.from(privateJwk.d, 'base64url');
  const scalarHex = scalar.toString('hex');
  const privateMarker = Buffer.from('-----BEGIN PRIVATE KEY-----', 'ascii');
  const cases = [
    {
      name: 'web public copied PEM',
      path: 'public/leaked.pem',
      bytes: privateMarker,
    },
    {
      name: 'iOS resource raw scalar',
      path: 'ios/App/App/Resources/leaked.bin',
      bytes: Buffer.from(scalarHex, 'hex'),
    },
    {
      name: 'Android asset scalar text',
      path: 'android/app/src/main/assets/leaked.txt',
      bytes: Buffer.from(scalarHex.toLowerCase(), 'ascii'),
    },
    {
      name: 'generated web bundle fixture reference',
      path: 'dist/assets/app.js',
      bytes: Buffer.from(
        "import '../../tests/fixtures/keys/b3-public-test-vector-p256-private.pem';",
        'utf8',
      ),
    },
    {
      name: 'generated native archive compressed private marker',
      path: '.native-build/b3/distribution/leaked.ipa',
      bytes: createDeflatedZip('Payload/leaked.pem', privateMarker),
      rawDoesNotContainMarker: true,
    },
    {
      name: 'unauthorised test fixture copy',
      path: 'tests/fixtures/copied-private-key.pem',
      bytes: privateMarker,
    },
    {
      name: 'unapproved key-directory fixture copy',
      path: 'tests/fixtures/keys/unapproved-private-key.pem',
      bytes: privateMarker,
    },
    {
      name: 'gateway runtime copied PEM',
      path: 'gateway/src/leaked.js',
      bytes: privateMarker,
    },
    {
      name: 'vendored runtime raw scalar',
      path: 'vendor/ks2-mastery/shared/spelling/mobile/a3/leaked.bin',
      bytes: scalar,
    },
    {
      name: 'generated Android Cordova plugin fixture reference',
      path: 'android/capacitor-cordova-android-plugins/src/main/assets/leaked.txt',
      bytes: Buffer.from('tests/fixtures/keys/b3-public-test-vector-p256-private.pem'),
    },
    {
      name: 'gateway bundle headerless PKCS8 base64',
      path: 'gateway/dist/worker.js',
      bytes: Buffer.from(privateDer.toString('base64'), 'ascii'),
    },
    {
      name: 'gateway build headerless PKCS8 base64url',
      path: 'gateway/build/worker.js',
      bytes: Buffer.from(privateDer.toString('base64url'), 'ascii'),
    },
    {
      name: 'packageable scalar standard base64',
      path: 'public/scalar.txt',
      bytes: Buffer.from(scalar.toString('base64'), 'ascii'),
    },
    {
      name: 'packageable scalar base64url',
      path: 'ios/App/App/scalar.txt',
      bytes: Buffer.from(scalar.toString('base64url'), 'ascii'),
    },
    {
      name: 'generated AAR compressed PKCS8 DER',
      path: 'android/app/build/outputs/aar/leaked.aar',
      bytes: createDeflatedZip(
        'classes/private-key.der',
        Buffer.concat([privateDer, privateDer]),
      ),
      rawExcludedBytes: privateDer,
    },
    {
      name: 'Capacitor Android build script fixture reference',
      path: 'android/app/capacitor.build.gradle',
      bytes: Buffer.from(
        'tests/fixtures/keys/b3-public-test-vector-p256-private.pem',
      ),
    },
    {
      name: 'Android ProGuard copied PEM',
      path: 'android/app/proguard-rules.pro',
      bytes: privateMarker,
    },
    {
      name: 'Android local libs compressed private AAR',
      path: 'android/app/libs/leaked.aar',
      bytes: createDeflatedZip(
        'classes/private-key.der',
        Buffer.concat([privateDer, privateDer]),
      ),
      rawExcludedBytes: privateDer,
    },
    {
      name: 'future Android flavour resource scalar',
      path: 'android/app/src/b3Sandbox/resources/leaked.bin',
      bytes: scalar,
    },
    {
      name: 'Cordova Android build script fixture reference',
      path: 'android/capacitor-cordova-android-plugins/build.gradle',
      bytes: Buffer.from('b3-public-test-vector-p256-private.pem'),
    },
    {
      name: 'Cordova Android variables scalar base64url',
      path: 'android/capacitor-cordova-android-plugins/cordova.variables.gradle',
      bytes: Buffer.from(scalar.toString('base64url'), 'ascii'),
    },
    {
      name: 'Cordova iOS podspec fixture reference',
      path: 'ios/capacitor-cordova-ios-plugins/CordovaPluginsResources.podspec',
      bytes: Buffer.from('b3-public-test-vector-p256-private.pem'),
    },
    {
      name: 'Cordova Android output compressed private AAR',
      path: 'android/capacitor-cordova-android-plugins/build/outputs/aar/leaked.aar',
      bytes: createDeflatedZip(
        'classes/private-key.der',
        Buffer.concat([privateDer, privateDer]),
      ),
      rawExcludedBytes: privateDer,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ks2-b3-key-exclusion-'));
      t.after(() => rm(root, { force: true, recursive: true }));
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'safe.js'), 'export const safe = true;\n');
      assert.equal(
        (await assertPrivateSigningFixtureExcluded({ root })).filesScanned,
        1,
      );

      const target = join(root, fixture.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fixture.bytes);
      if (fixture.rawDoesNotContainMarker) {
        assert.equal(fixture.bytes.indexOf(privateMarker), -1);
      }
      if (fixture.rawExcludedBytes) {
        assert.equal(fixture.bytes.indexOf(fixture.rawExcludedBytes), -1);
      }
      await assert.rejects(
        assertPrivateSigningFixtureExcluded({ root }),
        /private signing fixture.*packageable/i,
      );
    });
  }
});

test('the keyring rejects private material, production labels and shape drift', async () => {
  const valid = await readJson('config/pack-signing-public-keys.json');
  const mutations = [
    (value) => { value.privateKey = 'forbidden'; },
    (value) => { value.keys[0].privateKeyPem = 'forbidden'; },
    (value) => { value.keys[0].keyId = 'production-p256'; },
    (value) => { value.keys[0].testOnly = false; },
    (value) => { value.keys[0].allowedEnvironments.push('production'); },
    (value) => { value.keys[0].allowedPackIds.push('full-ks2'); },
    (value) => { value.keys.push(clone(value.keys[0])); },
    (value) => { value.keys[0].publicKeySpkiDerBase64 = 'placeholder'; },
    (value) => { value.keys[0].publicKeySpkiSha256 = '0'.repeat(64); },
  ];

  for (const mutate of mutations) {
    const candidate = clone(valid);
    mutate(candidate);
    assert.throws(() => assertPackKeyring(candidate), /keyring/i);
  }
});

test('the proof pack freezes bounded data-only identity and ceilings', async () => {
  const proofPack = await readJson('config/b3-proof-pack.json');

  assert.equal(assertB3ProofPack(proofPack), proofPack);
  assert.deepEqual(proofPack, {
    schemaVersion: 1,
    packId: 'b3-sandbox-proof',
    version: '1.0.0-b3.1',
    requiredEntitlementId: 'full-ks2',
    archiveName: 'b3-sandbox-proof.zip',
    allowedExtensions: ['.json', '.m4a'],
    ceilings: {
      fileCount: 16,
      compressedBytes: 1048576,
      extractedBytes: 4194304,
    },
  });
});

test('the proof pack rejects aliases, executable content and unbounded values', async () => {
  const valid = await readJson('config/b3-proof-pack.json');
  const mutations = [
    (value) => { value.alias = 'proof'; },
    (value) => { value.packId = 'production-full-ks2'; },
    (value) => { value.version = 'latest'; },
    (value) => { value.archiveName = '../proof.zip'; },
    (value) => { value.allowedExtensions.push('.js'); },
    (value) => { value.ceilings.fileCount = 0; },
    (value) => { value.ceilings.compressedBytes = Number.MAX_SAFE_INTEGER; },
    (value) => { value.ceilings.extractedBytes = Infinity; },
    (value) => { value.ceilings.extra = 1; },
  ];

  for (const mutate of mutations) {
    const candidate = clone(valid);
    mutate(candidate);
    assert.throws(() => assertB3ProofPack(candidate), /proof pack/i);
  }
});
