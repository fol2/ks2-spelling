from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEYBOARD_PACKAGE = "@capacitor/keyboard"


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def read_json(path: str):
    return json.loads(read(path))


def write_json(path: str, value) -> None:
    write(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sha256(path: str) -> str:
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def remove_dependency_authorities() -> None:
    policy_path = "config/dependency-policy.json"
    policy = read_json(policy_path)
    policy["directDependencies"].pop(KEYBOARD_PACKAGE, None)
    policy["npmClassifications"].pop(KEYBOARD_PACKAGE, None)
    policy["approvedNativePlugins"] = [
        entry
        for entry in policy["approvedNativePlugins"]
        if entry.get("packageName") != KEYBOARD_PACKAGE
    ]
    policy["allowedSources"]["gradleLocalDependencies"] = [
        entry
        for entry in policy["allowedSources"]["gradleLocalDependencies"]
        if entry != "project::capacitor-keyboard"
    ]
    generated_hashes = {
        "android/app/capacitor.build.gradle": sha256(
            "android/app/capacitor.build.gradle"
        ),
        "android/capacitor.settings.gradle": sha256(
            "android/capacitor.settings.gradle"
        ),
    }
    for entry in policy["gradleInputFiles"]:
        if entry["path"] in generated_hashes:
            entry["sha256"] = generated_hashes[entry["path"]]
    write_json(policy_path, policy)

    provenance_path = "provenance/b3-package-transition.json"
    provenance = read_json(provenance_path)
    provenance["allowedPackageDependencyAdditions"].pop(KEYBOARD_PACKAGE, None)
    write_json(provenance_path, provenance)

    authority_path = "scripts/lib/b3-package-transition-authority.mjs"
    authority = read(authority_path)
    marker = "// C7 spelling feel parity (2026-07-24 plan):"
    old_block = (
        "export const C7_PLANNED_PACKAGE_DEPENDENCY_ADDITIONS = Object.freeze({\n"
        "  '@capacitor/keyboard': '8.0.5',\n"
        "});"
    )
    if marker in authority and old_block in authority:
        start = authority.index(marker)
        end = authority.index(old_block, start) + len(old_block)
        replacement = (
            "// C7 keyboard chrome was reverted after physical iOS 27 evidence showed that\n"
            "// merely linking the native plugin changes WKWebView keyboard internals during\n"
            "// plugin load. The product keeps the standard iOS accessory bar instead.\n"
            "export const C7_PLANNED_PACKAGE_DEPENDENCY_ADDITIONS = Object.freeze({});"
        )
        authority = authority[:start] + replacement + authority[end:]
    elif "C7_PLANNED_PACKAGE_DEPENDENCY_ADDITIONS = Object.freeze({});" not in authority:
        raise SystemExit("Expected the C7 Keyboard dependency authority block.")
    write(authority_path, authority)


def update_dependency_audit_source() -> None:
    path = "scripts/audit-dependencies.mjs"
    source = read(path)
    source = source.replace(
        "  // The Keyboard plugin remains an audited native build source. Product\n"
        "  // JavaScript deliberately does not import or bundle its runtime facade.\n",
        "",
    )
    source = re.sub(
        r"^\s*'@capacitor/keyboard',\n", "", source, flags=re.MULTILINE
    )
    source = re.sub(
        r"^\s*':capacitor-keyboard',\n", "", source, flags=re.MULTILINE
    )
    source = source.replace(
        "Capacitor,Cordova,CapacitorCommunitySqlite,CapacitorApp,CapacitorHaptics,CapacitorKeyboard",
        "Capacitor,Cordova,CapacitorCommunitySqlite,CapacitorApp,CapacitorHaptics",
    )
    leftovers = [
        token
        for token in (KEYBOARD_PACKAGE, "CapacitorKeyboard", ":capacitor-keyboard")
        if token in source
    ]
    if leftovers:
        raise SystemExit(
            f"Native Keyboard authority remains in dependency audit source: {leftovers}"
        )
    write(path, source)


def update_dependency_tests() -> None:
    path = "tests/app-shell.test.mjs"
    source = read(path)
    source, count = re.subn(
        r"^\s*'@capacitor/keyboard': '8\.0\.5',\n",
        "",
        source,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit("Expected one app-shell Keyboard version authority.")
    write(path, source)

    path = "tests/dependency-policy.test.mjs"
    source = read(path)
    source, count = re.subn(
        r"  // 39 through C6; @capacitor/keyboard is the fortieth \(C7\)\.\n"
        r"  assert\.equal\(report\.npm\.production\.length, 40\);",
        "  // The C6 dependency set remains; the native Keyboard plugin was removed.\n"
        "  assert.equal(report.npm.production.length, 39);",
        source,
        count=1,
    )
    if count != 1:
        raise SystemExit("Expected the dependency production-count authority.")

    block = re.compile(
        r"  assert\.ok\(\n"
        r"    report\.npm\.production\.some\(\(\{ name \}\) => name === '@capacitor/keyboard'\),\n"
        r"    'the native Keyboard plugin must remain an audited production dependency',\n"
        r"  \);\n"
        r"  assert\.equal\(\n"
        r"    report\.npm\.webViewBundle\.packageNames\.includes\('@capacitor/keyboard'\),\n"
        r"    false,\n"
        r"    'ordinary keyboard ownership must not require the Keyboard JavaScript facade',\n"
        r"  \);\n"
    )
    replacement = (
        "  assert.equal(\n"
        "    report.npm.production.some(({ name }) => name === '@capacitor/keyboard'),\n"
        "    false,\n"
        "    'the Keyboard plugin must stay outside the installed production closure',\n"
        "  );\n"
        "  assert.equal(\n"
        "    report.npm.webViewBundle.packageNames.includes('@capacitor/keyboard'),\n"
        "    false,\n"
        "    'ordinary keyboard ownership must not require the Keyboard JavaScript facade',\n"
        "  );\n"
    )
    source, count = block.subn(replacement, source, count=1)
    if count != 1:
        raise SystemExit("Expected the dependency Keyboard assertion block.")
    source, count = re.subn(
        r"^\s*'@capacitor/keyboard',\n",
        "",
        source,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit("Expected one approved Keyboard plugin entry.")
    write(path, source)


def write_keyboard_ownership_contract() -> None:
    contract = r'''import assert from 'node:assert/strict';
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
'''
    write("tests/ios-keyboard-ownership.test.mjs", contract)


def update_incident_record() -> None:
    path = "docs/solutions/integration-issues/dictation-software-keyboard-ios27-incident.md"
    source = read(path)
    source = source.replace(
        "resolution_type: candidate_fix_pending_device_validation",
        "resolution_type: root_cause_fix_pending_device_validation",
        1,
    )
    source, count = re.subn(
        r"\*\*Candidate fix implemented; physical-device validation required\.\*\*[\s\S]*?"
        r"The incident remains open until the physical iPhone checklist below passes\.\n",
        """**Root-cause fix implemented; physical-device validation required.** A clean
uninstall, rebuild and reinstall of PR #53 at `3ce24c3c` reproduced the failure
across every ordinary text field, not only dictation. Quarantining JavaScript calls
was insufficient because Capacitor still auto-loaded the linked native Keyboard
plugin. The correction removes that package from npm, SwiftPM and Android entirely,
while retaining the Setup → Practice stable-input bridge.

The standard iOS form accessory bar is intentionally accepted. The incident remains
open until a clean physical-iPhone build proves ordinary fields and dictation again.
""",
        source,
        count=1,
    )
    if count != 1:
        raise SystemExit("Expected the incident status block.")
    source, count = re.subn(
        r"3\. Startup already calls `applyKeyboardChrome\(\)` →[\s\S]*?"
        r"by `keyboard-inset\.js` when wired\.\n",
        """3. Removing every JavaScript caller did not remove the native side effect. When
   `@capacitor/keyboard@8.0.5` remains linked, Capacitor auto-loads it. Its iOS
   `load()` removes keyboard-frame observers from the WKWebView and changes private
   `WKContentView` input methods. On the physical iOS 27 device, that native load
   path coincides with every text field losing the software keyboard.
""",
        source,
        count=1,
    )
    if count != 1:
        raise SystemExit("Expected the obsolete startup observation.")
    marker = "## Candidate F: persistent iOS input session"
    if marker not in source:
        raise SystemExit("Expected the Candidate F marker.")
    source = source.replace(
        marker,
        """## Candidate G: remove the native Keyboard plugin

The product does not need an API that can summon the keyboard on iOS—the official
plugin does not provide one. It was linked only to hide the standard form accessory
bar. That cosmetic benefit is not worth a native plugin which mutates every WKWebView
text field during load. Candidate G removes the package and all generated native
references, keeps Capacitor and WebKit defaults intact, and adds a closed regression
contract against future npm, SwiftPM, Android or runtime reintroduction.

## Candidate F: persistent iOS input session (insufficient while the plugin remained linked)""",
        1,
    )
    write(path, source)


def main() -> None:
    remove_dependency_authorities()
    update_dependency_audit_source()
    update_dependency_tests()
    write_keyboard_ownership_contract()
    update_incident_record()
    (ROOT / "src/platform/keyboard/capacitor-keyboard.js").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
