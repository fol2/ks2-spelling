import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEYBOARD_PACKAGE = '@capacitor/keyboard';

async function collectRuntimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectRuntimeSources(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('ordinary iOS fields retain native keyboard ownership', async () => {
  const [
    packageJsonSource,
    packageLockSource,
    capacitorConfigSource,
    dependencyPolicySource,
    transitionAuthoritySource,
    packageSwiftSource,
    androidSettingsSource,
    androidBuildSource,
    dependencyAuditSource,
    mainSource,
    productRootSource,
    productAppSource,
    sessionSource,
    sceneDelegateSource,
    nativeTestSource,
  ] = await Promise.all([
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, 'package-lock.json'), 'utf8'),
    readFile(join(ROOT, 'capacitor.config.json'), 'utf8'),
    readFile(join(ROOT, 'config/dependency-policy.json'), 'utf8'),
    readFile(join(ROOT, 'provenance/b3-package-transition.json'), 'utf8'),
    readFile(join(ROOT, 'ios/App/CapApp-SPM/Package.swift'), 'utf8'),
    readFile(join(ROOT, 'android/capacitor.settings.gradle'), 'utf8'),
    readFile(join(ROOT, 'android/app/capacitor.build.gradle'), 'utf8'),
    readFile(join(ROOT, 'scripts/audit-dependencies.mjs'), 'utf8'),
    readFile(join(ROOT, 'src/main.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/ios-dictation-input-session.js'), 'utf8'),
    readFile(join(ROOT, 'ios/App/App/SceneDelegate.swift'), 'utf8'),
    readFile(join(ROOT, 'ios/App/B3ProofUITests/C5ProductLayoutTests.swift'), 'utf8'),
  ]);

  const packageJson = JSON.parse(packageJsonSource);
  const packageLock = JSON.parse(packageLockSource);
  const capacitorConfig = JSON.parse(capacitorConfigSource);
  const dependencyPolicy = JSON.parse(dependencyPolicySource);
  const transitionAuthority = JSON.parse(transitionAuthoritySource);

  assert.equal(Object.hasOwn(packageJson.dependencies ?? {}, KEYBOARD_PACKAGE), false);
  assert.equal(
    Object.hasOwn(packageLock.packages?.['']?.dependencies ?? {}, KEYBOARD_PACKAGE),
    false,
  );
  assert.equal(
    Object.hasOwn(packageLock.packages ?? {}, `node_modules/${KEYBOARD_PACKAGE}`),
    false,
  );
  assert.equal(Object.hasOwn(dependencyPolicy.directDependencies, KEYBOARD_PACKAGE), false);
  assert.equal(Object.hasOwn(dependencyPolicy.npmClassifications, KEYBOARD_PACKAGE), false);
  assert.equal(
    dependencyPolicy.approvedNativePlugins.some(
      ({ packageName }) => packageName === KEYBOARD_PACKAGE,
    ),
    false,
  );
  assert.equal(
    dependencyPolicy.allowedSources.gradleLocalDependencies.includes(
      'project::capacitor-keyboard',
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      transitionAuthority.allowedPackageDependencyAdditions,
      KEYBOARD_PACKAGE,
    ),
    false,
  );

  assert.equal(capacitorConfig.plugins?.Keyboard, undefined);
  assert.doesNotMatch(packageSwiftSource, /CapacitorKeyboard|@capacitor\/keyboard/);
  assert.doesNotMatch(androidSettingsSource, /capacitor-keyboard|@capacitor\/keyboard/);
  assert.doesNotMatch(androidBuildSource, /capacitor-keyboard|@capacitor\/keyboard/);
  assert.doesNotMatch(
    dependencyAuditSource,
    /@capacitor\/keyboard|CapacitorKeyboard|:capacitor-keyboard/,
  );
  assert.equal(
    existsSync(join(ROOT, 'src/platform/keyboard/capacitor-keyboard.js')),
    false,
    'the old global Keyboard helper must not survive as an importable seam',
  );

  assert.doesNotMatch(mainSource, /applyKeyboardChrome|@capacitor\/keyboard/);
  for (const path of await collectRuntimeSources(join(ROOT, 'src'))) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(
      source,
      /@capacitor\/keyboard|capacitor-keyboard\.js/,
      `${relative(ROOT, path)} must not load the native Keyboard plugin`,
    );
    assert.doesNotMatch(
      source,
      /Keyboard\.(?:setResizeMode|setScroll|setAccessoryBarVisible|show|hide)\s*\(/,
      `${relative(ROOT, path)} must not mutate app-wide keyboard behaviour`,
    );
  }

  assert.match(
    sceneDelegateSource,
    /bridgeViewController\.loadViewIfNeeded\(\)[\s\S]*?bridgeViewController\.webView\?\.capacitor\.setKeyboardShouldRequireUserInteraction\(nil\)/,
    'the app must clear Capacitor core’s per-WebView forced-interaction flag after bridge creation',
  );
  assert.doesNotMatch(
    sceneDelegateSource,
    /setKeyboardShouldRequireUserInteraction\((?:true|false)\)/,
    'the app must preserve WebKit’s real user-interaction value instead of forcing either state',
  );

  assert.doesNotMatch(productRootSource, /installIOSDictationInputSession/);
  assert.match(
    productAppSource,
    /const needsDictationSession = learningState\.screen === 'setup'\s*\|\|\s*learningState\.screen === 'practice';/s,
  );
  assert.match(productAppSource, /return installIOSDictationInputSession\(\);/);
  assert.match(productAppSource, /}, \[needsDictationSession\]\);/);
  assert.match(productAppSource, /id="bank-search-input"[\s\S]*?type="text"/);
  assert.match(
    sessionSource,
    /function park\(\)[\s\S]*?pointerEvents: 'none'[\s\S]*?translate\(-200vw, -200vh\)/,
  );
  assert.doesNotMatch(sessionSource, /Keyboard\.show|keyboardDisplayRequiresUserAction/);

  assert.match(nativeTestSource, /func testProductNicknameFieldRaisesSoftwareKeyboard\(\)/);
  assert.match(nativeTestSource, /nickname\.tap\(\)/);
  assert.match(nativeTestSource, /application\.keyboards\.firstMatch/);
  assert.match(nativeTestSource, /keyboard\.waitForExistence\(timeout: 5\)/);
  assert.match(nativeTestSource, /nickname\.typeText\("Keyboard guard"\)/);
});
