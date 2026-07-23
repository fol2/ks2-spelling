import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DEFAULT_CAPACITOR_HASHES = Object.freeze({
  'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png':
    '29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b',
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png':
    '1b5002b74a5500e697298ced06ca2811ac33f2771f236f3c720ff23243890530',
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png':
    '87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761',
  'android/app/src/main/res/drawable-port-xxxhdpi/splash.png':
    '3db071a03b2f8ffe0dfd4170fc59842d53cd15bba5e88af59401d58efabf7827',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPngHeader(bytes) {
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  return Object.freeze({
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
  });
}

test('production native shells use the repository-owned Pocket Expedition branding', async () => {
  for (const [path, defaultHash] of Object.entries(DEFAULT_CAPACITOR_HASHES)) {
    const actualHash = sha256(await readFile(path));
    assert.notEqual(
      actualHash,
      defaultHash,
      `${path} still contains the default Capacitor artwork`,
    );
  }

  const authority = await readFile(
    'assets/branding/README.md',
    'utf8',
  );
  assert.match(authority, /Pocket Expedition/u);
  assert.match(authority, /created for KS2 Spelling/u);
  assert.match(authority, /no third-party artwork/u);
});

test('the iOS App Icon is an opaque 8-bit 1024-pixel PNG', async () => {
  const bytes = await readFile(
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
  );
  assert.deepEqual(readPngHeader(bytes), {
    width: 1024,
    height: 1024,
    bitDepth: 8,
    colourType: 2,
  });
});
