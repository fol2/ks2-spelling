import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

async function runtimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeSources(path));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function nativeAppSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await nativeAppSources(path));
    else if (/\.(?:h|m|mm|swift)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function visibleSpellingInput(productApp) {
  const identity = 'id="product-spelling-input"';
  const identityOffset = productApp.indexOf(identity);
  assert.notEqual(identityOffset, -1, 'the Practice screen must identify its spelling input');
  assert.equal(
    productApp.indexOf(identity, identityOffset + identity.length),
    -1,
    'the Practice screen must have exactly one spelling input identity',
  );

  const start = productApp.lastIndexOf('<input', identityOffset);
  const end = productApp.indexOf('/>', identityOffset);
  assert.ok(
    start >= 0 && end > identityOffset,
    'the Practice spelling input must be one complete JSX input element',
  );
  return productApp.slice(start, end + 2);
}

test('the product leaves keyboard ownership with the real visible field', async () => {
  const [productRoot, main, productApp, productCss] = await Promise.all([
    source('src/app/ProductRoot.jsx'),
    source('src/main.jsx'),
    source('src/app/ProductApp.jsx'),
    source('src/app/app.css'),
  ]);
  const input = visibleSpellingInput(productApp);

  assert.match(input, /name="spelling"/u);
  assert.match(input, /type="text"/u);
  assert.match(input, /value=\{answer\}/u);
  assert.match(input, /aria-readonly=\{busy \|\| answered\}/u);
  assert.match(
    input,
    /onBeforeInput=\{\(event\) => \{[\s\S]*?if \(busy \|\| answered\) event\.preventDefault\(\);[\s\S]*?\}\}/u,
  );
  assert.match(
    input,
    /onChange=\{\(event\) => \{[\s\S]*?if \(!busy && !answered\) setAnswer\(event\.target\.value\);[\s\S]*?\}\}/u,
  );
  assert.doesNotMatch(
    input,
    /(?:\bautoFocus\b|\breadOnly\b|\bdisabled\b|\bhidden\b|aria-hidden|\binert\b|tabIndex=\{-1\})/u,
    'the visible spelling field must remain mounted, enabled and focusable',
  );

  assert.doesNotMatch(
    productRoot,
    /ios-dictation-input-session|installIOSDictationInputSession|observeKeyboardInset/u,
  );
  assert.doesNotMatch(main, /applyKeyboardChrome|@capacitor\/keyboard/u);
  assert.doesNotMatch(
    productApp,
    /document\.createElement\(['"]input['"]\)|appendChild\([^)]*input|visualViewport|Keyboard\.(?:show|hide|setResizeMode|setAccessoryBarVisible)/u,
    'the product must not create or drive a second keyboard-owning input',
  );
  assert.doesNotMatch(
    productApp,
    /disabled=\{busy \|\| answered\}/u,
    'saving and feedback must not disable the focused spelling field and dismiss iOS keys',
  );
  assert.doesNotMatch(
    productCss,
    /--keyboard-inset|data-dictation-input-session|dictation-visible-height/u,
    'layout must not own software-keyboard geometry',
  );
});

test('the native probe opens the learner form and reaches the real Practice field', async () => {
  const nativeProbe = await source(
    'ios/App/B3ProofUITests/C5ProductLayoutTests.swift',
  );

  assert.match(nativeProbe, /buttons\["Add a learner"\]/u);
  assert.match(nativeProbe, /buttons\["Set off"\]/u);
  assert.match(nativeProbe, /textFields\["Type the spelling"\]/u);
  assert.match(nativeProbe, /openPracticeForKeyboardProbe/u);
  assert.match(nativeProbe, /spelling\.typeText\("zzzzzz"\)/u);
  assert.match(nativeProbe, /pressSubmissionKey\(on: keyboard\)/u);
  assert.match(nativeProbe, /requireSoftwareLetterKeys\(in: application\)/u);
  assert.match(nativeProbe, /spelling\.typeText\("a"\)/u);
});

test('the native Keyboard plugin stays absent from runtime and dependency roots', async () => {
  const [packageJson, packageLock, capacitorConfig] = await Promise.all([
    source('package.json'),
    source('package-lock.json'),
    source('capacitor.config.json'),
  ]);

  assert.equal(Object.hasOwn(JSON.parse(packageJson).dependencies ?? {}, '@capacitor/keyboard'), false);
  const lock = JSON.parse(packageLock);
  assert.equal(Object.hasOwn(lock.packages?.['']?.dependencies ?? {}, '@capacitor/keyboard'), false);
  assert.equal(Object.hasOwn(lock.packages ?? {}, 'node_modules/@capacitor/keyboard'), false);
  assert.equal(JSON.parse(capacitorConfig).plugins?.Keyboard, undefined);

  for (const path of await runtimeSources(join(root, 'src'))) {
    const contents = await readFile(path, 'utf8');
    assert.doesNotMatch(
      contents,
      /@capacitor\/keyboard|capacitor-keyboard\.js/u,
      `${relative(root, path)} must not load the retired Keyboard plugin`,
    );
  }
});

test('the App target does not swizzle private WebKit accessory-view implementations', async () => {
  const project = await source('ios/App/App.xcodeproj/project.pbxproj');
  assert.doesNotMatch(
    project,
    /HideFormAccessoryBar|FormAccessoryBar/u,
    'the shipping App target must not wire a private accessory-bar helper',
  );

  const runtimeMutation = /(?:method_setImplementation|method_exchangeImplementations|class_replaceMethod|class_addMethod|objc_allocateClassPair|object_setClass|imp_implementationWithBlock)/u;
  const privateAccessory = /(?:WKContentView|UIWebBrowserView|HideFormAccessoryBar|inputAccessoryView)/u;
  for (const path of await nativeAppSources(join(root, 'ios', 'App', 'App'))) {
    const contents = await readFile(path, 'utf8');
    assert.doesNotMatch(
      contents,
      runtimeMutation,
      `${relative(root, path)} must not mutate Objective-C method implementations to hide keyboard chrome`,
    );
    assert.doesNotMatch(
      contents,
      privateAccessory,
      `${relative(root, path)} must not depend on private WebKit accessory-view classes`,
    );
  }
});

test('the retired hidden-input and viewport-ownership files stay absent', () => {
  const retired = [
    'src/app/keyboard-inset.js',
    'src/app/ios-dictation-input-session.css',
    'src/platform/keyboard/capacitor-keyboard.js',
    'src/platform/keyboard/ios-dictation-input-session.js',
  ];

  for (const path of retired) {
    assert.equal(
      existsSync(join(root, path)),
      false,
      `${path} must not return as a second keyboard subsystem`,
    );
  }
});

test('one-use restack machinery stays out of the durable branch', () => {
  assert.equal(
    existsSync(join(root, '.github/workflows/pr55-final-words-restack.yml')),
    false,
    'the verified restack workflow must remove itself before the branch is reviewable',
  );
  assert.equal(
    existsSync(join(root, '.github/workflows/pr55-practice-probe-hardening.yml')),
    false,
    'the one-use Practice probe workflow must not remain in the durable branch',
  );
});

test('the retained keyboard gate verifies exact heads and base retargets', async () => {
  const workflow = await source('.github/workflows/pr55-visible-input-gate.yml');

  assert.match(
    workflow,
    /types:\s*\[[^\]]*synchronize[^\]]*edited[^\]]*ready_for_review[^\]]*\]/u,
  );
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    'a fork with the same branch name must not run the owned native gate',
  );
  assert.match(
    workflow,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|/u,
    'the gate must check out the immutable event head rather than a moving branch',
  );
  assert.match(workflow, /PR_BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$PR_BASE_SHA" HEAD/u);
  assert.match(
    workflow,
    /github\.event\.action == 'edited'[\s\S]*github\.event\.changes\.base == null/u,
    'description-only edits must stop after exact-head/base verification',
  );
  assert.match(
    workflow,
    /github\.event\.action != 'edited' \|\|[\s\S]*github\.event\.changes\.base != null/u,
    'base retargets must rerun the full web/native gate',
  );
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/u);
  assert.doesNotMatch(workflow, /contents:\s*write/u);
});
