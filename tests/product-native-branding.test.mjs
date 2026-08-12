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

const SELECTED_ICON_SOURCE =
  'assets/branding/icon-concepts/vellhorn-spelling-b-selected.png';
const ADAPTIVE_ICON_SOURCE =
  'assets/branding/vellhorn-spelling-b-adaptive-foreground.png';

const RETAINED_ICON_CONCEPTS = Object.freeze([
  'assets/branding/icon-concepts/inklet-cat.png',
  'assets/branding/icon-concepts/glimmerbug-letter-a.png',
  SELECTED_ICON_SOURCE,
]);

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

test('production native shells use the repository-owned spelling-companion branding', async () => {
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
  assert.match(authority, /Vellhorn/u);
  assert.match(authority, /spelling/u);
  assert.match(authority, /default native app icon/u);
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

test('the selected icon concept and iOS derivative preserve the approved artwork', async () => {
  const [source, appIcon] = await Promise.all([
    readFile(SELECTED_ICON_SOURCE),
    readFile(
      'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
    ),
  ]);

  assert.equal(readPngHeader(source).colourType, 2);
  assert.deepEqual(readPngHeader(appIcon), {
    width: 1024,
    height: 1024,
    bitDepth: 8,
    colourType: 2,
  });
  assert.equal(sha256(source), sha256(appIcon));
});

test('all three approved icon explorations remain as opaque master artwork', async () => {
  for (const path of RETAINED_ICON_CONCEPTS) {
    const bytes = await readFile(path);
    assert.deepEqual(readPngHeader(bytes), {
      width: 1024,
      height: 1024,
      bitDepth: 8,
      colourType: 2,
    });
  }
});

test('Android adaptive icon derivatives use transparent foreground artwork', async () => {
  const densities = Object.freeze({
    mdpi: 108,
    hdpi: 162,
    xhdpi: 216,
    xxhdpi: 324,
    xxxhdpi: 432,
  });

  for (const [density, size] of Object.entries(densities)) {
    const bytes = await readFile(
      `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
    );
    assert.deepEqual(readPngHeader(bytes), {
      width: size,
      height: size,
      bitDepth: 8,
      colourType: 6,
    });
  }

  const masterBytes = await readFile(ADAPTIVE_ICON_SOURCE);
  assert.deepEqual(readPngHeader(masterBytes), {
    width: 1024,
    height: 1024,
    bitDepth: 8,
    colourType: 6,
  });

  const background = await readFile(
    'android/app/src/main/res/values/ic_launcher_background.xml',
    'utf8',
  );
  assert.match(background, /#16321D/u);
});

test('the current product licence authority is distinct from the B3 technical audit', async () => {
  const [licenceNotice, terms, b3Inventory] = await Promise.all([
    readFile('docs/legal/third-party-licence-notice.md', 'utf8'),
    readFile('docs/legal/terms-of-use.md', 'utf8'),
    readFile('THIRD_PARTY_NOTICES.md', 'utf8'),
  ]);

  assert.match(
    licenceNotice,
    /current C5 product licence authority/u,
  );
  assert.match(
    licenceNotice,
    /`THIRD_PARTY_NOTICES\.md` remains the generated B3 technical dependency audit/u,
  );
  assert.match(
    licenceNotice,
    /do not describe\s+ProductApp's runtime mode or network endpoints/u,
  );
  assert.match(
    terms,
    /current product licence authority is\s+`docs\/legal\/third-party-licence-notice\.md`/u,
  );
  assert.match(
    b3Inventory,
    /deterministic dependency inventory for the B3 compiled sandbox capability/u,
  );
});
