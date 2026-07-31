---
module: native-ios-packaging
date: 2026-07-27
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Proof and product compositions share a native bundle identifier"
  - "A workflow can rebuild, install, or replace an application on a physical device"
  - "A native skill determines how to verify a fix but not which application composition to install"
resolution_type: workflow_improvement
related_components:
  - "tooling"
  - "testing_framework"
tags:
  - "ios"
  - "physical-device"
  - "build-identity"
  - "bundle-identifier"
  - "b4-development"
  - "proof-composition"
  - "product-composition"
---

# Gate physical iOS installs on application composition

## Context

This learning records the conclusion of the retained Codex task trace dated
2026-07-27: after a small dictation auto-advance change, a B4Development proof
composition was installed on the connected physical iPhone instead of the normal
full product composition. According to that retained task trace, the code change
itself was narrow and correct, and the native application compiled, installed,
and launched, but those successes proved the wrong build identity.

The retained wrong artefact at
`.native-build/ios-quick/Build/Products/Debug-iphoneos/App.app` is 19 MB with 76
files under `public/` and contains the B4Development marker. The restored
product artefact at
`.native-build/ios-default-restore/Build/Products/Debug-iphoneos/App.app` is
475 MB with 9,075 files and does not contain that marker. Both report
`uk.eugnel.ks2spelling` as their bundle identifier, so the proof installation
looked like an update to the existing product application.

Every `.native-build/` path cited in this record is a measurement captured in
the ignored working directory during the incident, not a file kept in the
repository. Expect them to be absent on any other checkout; they are quoted as
evidence of what was observed, not as artefacts to reopen.

## Root-cause attribution

The retained task trace supports the following incident attribution; these are
session-history findings, not behaviours inferred from the current source tree.
No single prompt, instruction, or repository document in that trace said to
install B4Development. The incident required a chain of separate triggers and
one incorrect composition choice:

| Input | Effect | What it did not authorise |
| --- | --- | --- |
| The user asked to build and load the fix on the connected real iPhone. | Authorised a physical-device build and installation. | It did not request a B4 proof composition. |
| The available `ios-fix` skill described rebuilding, redeploying, and verifying an iOS fix on a real device with zero human intervention. | Triggered the extended native verification workflow. | It did not name B4Development or select a product composition. |
| Ponytail full mode preferred an existing repository path and the shortest working route. | Made the ready-made B4 sync command an attractive route. | It did not explicitly instruct the workflow to use B4. |
| Default collaboration guidance preferred making a reasonable assumption and continuing instead of stopping for a non-essential question. | Reduced pressure to ask which composition was intended. | It did not make B4 a reasonable default when the request was for the product app. |
| `approval_policy: never` and unrestricted filesystem/process access were active. | Allowed the chosen sync, build, install, and launch commands to execute without another approval pause. | These settings enabled execution; they did not choose the composition. |
| `package.json` exposed `sync:b4-development` as a one-command build and Capacitor sync path. | Became the proximate route that changed the native web payload to B4Development. | The presence of a script was not an instruction to use it. |

The retained trace records the order directly: line 14 selected `ios-fix`, line
170 announced the B4 development sync, line 176 inspected the B4 physical-proof
script, line 186 ran `npm run sync:b4-development`, and line 216 confirmed the
B4 marker and installed that artefact. The session-level conclusion is therefore
that the proof script reinforced an already announced B4 choice; it did not
originate it.

Repository guidance pointed the other way. The normal native runbook uses
`npm run build` (`docs/operations/native-development.md:30`), while the B4 plan
defines a separate development slice and says to keep the normal composition
unchanged
(`docs/superpowers/plans/2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md:102`).
Project instructions also require fresh evidence for the exact native target,
configuration, and device, with configuration, compilation, and launch treated
as separate gates (`AGENTS.md:36`).

## Why the wrong build replaced the product

`package.json:13` defines the normal Vite build, while `package.json:14` and
`package.json:15` define the explicit B4 build and sync. B4Development changes
the app composition and injects a marker into the bundled HTML
(`vite.config.js:10`, `vite.config.js:19`, `vite.config.js:85`); production mode
selects the product root and copies the full audio and art assets
(`vite.config.js:43`, `vite.config.js:64`, `vite.config.js:94`).

The service selector likewise maps B4Development to `b4-starter-product` and
production to `ks2-spelling-product`
(`src/app/create-app-services.js:23`,
`src/app/create-app-services.js:30`). This means the Vite mode changes the
application experience before Xcode packages it.

The native wrapper does not distinguish those experiences. Capacitor declares
`uk.eugnel.ks2spelling` (`capacitor.config.json:2`), and both Debug and Release
Xcode configurations use that identifier
(`ios/App/App.xcodeproj/project.pbxproj:525`,
`ios/App/App.xcodeproj/project.pbxproj:547`). The B4 physical-proof script uses
the same identifier, runs `sync:b4-development`, requires the B4 marker, and
uninstalls then installs that application
(`scripts/prove-b4-ios-physical.mjs:17`,
`scripts/prove-b4-ios-physical.mjs:264`,
`scripts/prove-b4-ios-physical.mjs:288`).

A matching bundle identifier therefore proved only native application identity,
not product composition.

## Recovery

The recovery treated the application payload, data container, and visible UI as
separate evidence:

1. Copy the permitted application-container directories and run
   `PRAGMA quick_check` on the copied SQLite database.
2. Run the normal `npm run build`, then `npx cap sync ios`, and fail if the
   synced `index.html` contains a B4 or B3 proof marker. There is no product
   `sync:*` npm script — the only one is `sync:b4-development`, which syncs the
   proof composition and is the very mistake this record exists to prevent.
3. Build the `KS2Spelling` Debug application for the exact physical destination
   into a fresh derived-data directory.
4. Verify the built application exists, has no proof marker, passes signature
   verification, and contains the expected product asset footprint.
5. Install it over the existing application without uninstalling first, then
   launch and capture the product-only Trail interface.
6. Copy the SQLite database again and compare it with the pre-install copy.

For this recovery, the retained databases at
`.native-build/recovery/app-data-before-default-restore/Library/CapacitorDatabase/ks2-spellingSQLite.db`
and
`.native-build/recovery/app-data-after-default-restore/ks2-spellingSQLite.db`
have the same SHA-256,
`9e52ecba46148d9714263036df298682b7afc0b72c79b57687fead6cce2b7d4e`,
and both copies returned `ok` from `PRAGMA quick_check`. This proves preservation
for this recovery only; it is not a general guarantee that every same-identifier
installation preserves compatible data.

## Prevention

### Assert composition before sync and install

A product installation path must reject proof markers in both the synced web
payload and the final `.app`:

```sh
synced_index_path="ios/App/App/public/index.html"
app_index_path="$app_path/public/index.html"

for index_path in "$synced_index_path" "$app_index_path"; do
  test -f "$index_path"
  ! rg -q 'B4Development|B3SandboxProof' "$index_path"
done
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")" = \
  'uk.eugnel.ks2spelling'
```

The bundle-identifier check is necessary but insufficient; the composition
check is decisive.

### Make product the default and proof modes explicit

The ordinary build-and-load path should use `npm run build`. Any proof path
should require an explicit mode argument, print the selected composition, and
refuse to infer proof mode from a request to install the product app.

### Separate proof identity when simultaneous installs are intended

A dedicated proof bundle identifier prevents a proof build from silently
updating the product application or inheriting its data container. Add that
isolation when proof and product applications are meant to coexist; marker
checking remains useful for detecting packaging mistakes.

### Protect learner data before same-identity replacement

Before replacing an application on a physical device, retain the intended
composition, exact destination, bundle identifier, and permitted data-container
backup. Verify SQLite integrity before the install and compare post-install
state. Use byte hashes only when byte-for-byte preservation is expected; use a
migration-aware comparison when the new build intentionally migrates data.

### Keep visible product verification as a separate gate

Build success, install success, and process launch do not prove the requested
product experience. Launch the exact physical device and verify a product-only
screen or accessibility identifier before reporting the device hand-off as
complete.

## Related

- `docs/solutions/conventions/adding-a-package-json-script.md`
- `docs/operations/native-development.md`
- `docs/superpowers/plans/2026-07-18-standalone-spelling-mobile-b4-capacitor-development-certification.md`
