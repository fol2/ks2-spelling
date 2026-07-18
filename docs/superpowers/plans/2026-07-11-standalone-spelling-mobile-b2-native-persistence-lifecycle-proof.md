# Standalone Spelling Mobile B2 Native Persistence and Lifecycle Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every task and `superpowers:verification-before-completion` before the exit commit. Steps use checkbox (`- [ ]`) syntax for tracking. Every task requires an independent spec-compliance and code-quality review before the next task begins.

**Goal:** Prove that the frozen A3 Spelling command contract can run entirely locally through one real SQLite unit of work on iOS and Android, preserving two learners' independent state across backgrounding, foregrounding and process termination without expanding the B1 diagnostic shell into production UI.

**Architecture:** Keep the 24-file Gate A runtime closure byte-for-byte frozen. Add an application-owned asynchronous SQL port with a Node `node:sqlite` test adapter and one native `@capacitor-community/sqlite` adapter. The SQLite repository reconstructs one validated A3 snapshot, plans through the frozen A3 function, writes every durable consequence inside one transaction, advances the revision with compare-and-set, then releases transient effects only after commit. A narrow `@capacitor/app` adapter drives an idempotent lifecycle coordinator; lifecycle callbacks improve checkpointing but never become a correctness dependency.

**Tech Stack:** Node.js `24.18.0`, npm `11.16.0`, ESM JavaScript, React `19.2.7`, Vite `8.1.4`, Capacitor `8.4.1`, `@capacitor-community/sqlite@8.1.0`, `@capacitor/app@8.1.0`, Node built-in `node:sqlite` for tests only, Swift Package Manager, Xcode `26+`, Android API `36`, Android Build Tools `36.0.0`, Android Studio JBR Java `21` and `node:test`.

## Authority and frozen entry evidence

| Evidence | Frozen B2 entry value |
|---|---|
| Mobile repository | `https://github.com/fol2/ks2-spelling.git` |
| B1 merged `main` commit | `47c8ae791ccb521c8aafdfd297f1c211fd5981d4` |
| B1 merged tree | `ce0f2f483c0f21975ef3807a2a668b6d32b5c24e` |
| B1 hosted CI | `https://github.com/fol2/ks2-spelling/actions/runs/29160017974` — Domain/Web, iOS unsigned Simulator compile and Android unsigned debug compile all successful at the exact B1 commit |
| B1 dependency audit SHA-256 | `1af859ea0a499c24fb33975149b8777c47225da9a1c388cbb6fc1dc9b0a3385c` |
| B1 exit report SHA-256 | `8ca42ff4c6eef28b9861eae8749996a0c1e05aff5b784f789eadb817a638ab2a` |
| Gate A upstream commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| Gate A upstream tree | `129ba457cccf21df03f4be813b4f4ed6e7d9f6ad` |
| A3 manifest SHA-256 | `7fea17613ee10f747c1cfa9d5c923da4e506e23e61d1530ca71c283c0ce39465` |
| B1 application fingerprint | `0755706083060caf3fa370d2abfd8acabefc0774ac45f3476edefe7b651125d6` |
| B1 tested application commit | `c7828c2da84d5828f7e7640992c78d3203dd1170` |

The product/design authority remains:

- [Standalone Spelling Mobile Application Design](../specs/2026-07-09-standalone-spelling-mobile-application-design.md)
- [Standalone Spelling Mobile Programme](2026-07-09-standalone-spelling-mobile-programme.md)
- [B1 Source Authority and Boundaries](../../architecture/b1-authority.md)
- `vendor/ks2-mastery/content/spelling.mobile-a3-contract-manifest.json`

## Global constraints

- Use UK English in code, comments, documentation, commit messages and product copy.
- Keep bundle/application identity exactly `uk.eugnel.ks2spelling`, iOS scheme exactly `KS2Spelling`, app name exactly `KS2 Spelling`, iOS deployment floor `15.0`, Android minimum API `24`, target/compile API `36`, Build Tools `36.0.0` and Java `21`.
- The application remains local-only. `capacitor.config.json` and installed bundles must have `server.url === null`; B2 adds no endpoint, account, cloud progress, analytics, advertising, download, filesystem or commerce capability.
- The Gate A 24-file runtime closure and five certified content/manifest files remain byte-for-byte unchanged. Producer tests are test-only vendor inputs and do not change the runtime count.
- Starter contains exactly 20 items; Full contains exactly 213 items; both use permanent `packId` `ks2-core`; Starter has no Full entitlement and no Camp state.
- Durable state always belongs to one `learnerId`. Two seeded learners must not read or mutate one another's subject state, session, event log, Monster state, Camp state or revision.
- Monster state remains child-owned and spelling-derived. No Parent projection, Parent field or Parent analytics value may be persisted in Monster or Camp tables.
- B2 implements only the A3 repository public surface `{ runCommandTransaction }`. Production asynchronous profile CRUD remains C2; B2 may create and deterministically seed profile rows solely to prove learner isolation.
- Every changed A3 command begins one SQLite transaction, rereads and validates a fresh snapshot, samples the repository clock exactly once per conflict attempt, validates the complete returned plan, writes every durable target, advances revision with compare-and-set and commits once.
- The failure checkpoints remain exactly `after-subject-state`, `after-practice-session`, `after-events`, `after-monster-state`, `after-camp-state`, `after-revision` and `before-commit`.
- Revision conflicts retry from a newly read snapshot. Preserve `SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS === 3`; never apply a stale plan.
- Transient effects are returned only after a successful commit and never escape a rollback, thrown planner, validation failure or exhausted conflict.
- The database name is exactly `ks2-spelling`, physical plugin filename `ks2-spellingSQLite.db`, schema version `1` and connection settings `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`.
- B2 uses explicit SQLite mode `no-encryption`. Do not initialise the plugin's Web/IndexedDB/WASM path. Parent PIN, biometrics, database-key handling and production encryption-at-rest belong to C2.
- `@capacitor-community/sqlite@8.1.0` is conditionally approved only after both native builds, the full npm/SPM/Maven audit, zero packaged Android permissions and zero new iOS usage descriptions/entitlements pass. Its npm integrity must equal `sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==`.
- `@capacitor/app@8.1.0` is conditionally approved only after the same audit. Its npm integrity must equal `sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==`.
- SQLCipher ships even when B2 opens an unencrypted database. The compliance register must state that US encryption export classification/reporting remains unresolved release work. Do not set `ITSAppUsesNonExemptEncryption` or claim a store answer in B2.
- Remove `android.permission.USE_BIOMETRIC` and `android.permission.USE_FINGERPRINT` contributed by the transitive AndroidX biometric graph. The packaged APK permission list must remain empty.
- SwiftPM must commit `Package.resolved` with every identity and revision pinned. Validate resolution kind exactly: a branch dependency requires its exact branch plus revision; a version dependency requires its exact semantic version plus revision. Reject missing or drifting resolved evidence.
- No paid Capawesome/private-registry dependency, CocoaPods conversion, silent plugin substitution, dependency-audit weakening or additional spending is authorised. Failure of the community plugin to meet SPM or zero-permission gates is a real B2 failure.
- The B2 UI remains visibly labelled `B2 persistence proof`. It is evidence UI, not the visual/theme/asset migration and not a public product screen.
- Do not implement Parent UI, production profiles, PIN/biometrics, reset/delete, platform backup, `backup.sqlite`, billing, purchases, entitlements, downloads, production audio, Full KS2 UI, Guardian/Boss/Pattern Quest UI, Hero Mode/Hero Camp, final visual design, accessibility certification, physical-device certification, store signing or release metadata.
- TDD is mandatory. Each task starts with a focused failing test, records the expected RED reason, adds the smallest complete behaviour, reruns its focused gate and commits independently.
- The controller records each clean task review in `.superpowers/sdd/progress.md`, creates review packages from the exact task base, resolves every Critical/Important finding, and obtains one broad whole-branch review before merge.

## File structure

### Frozen producer evidence

- `vendor/ks2-mastery/tests/spelling-mobile-a3-*.test.js`: nine exact Gate A producer tests, copied byte-for-byte under a mirrored relative layout.
- `provenance/ks2-mastery-gate-a.json`: records producer-test paths and SHA-256 values separately from the 24-file runtime closure.
- `scripts/verify-vendored-contract.mjs`: fail-closed validation of the 29 B1 vendor files plus nine test-only producer files.

### Database boundary

- `src/platform/database/sql-connection-contract.js`: validates the application-owned asynchronous SQL port.
- `src/platform/database/schema-v1.js`: owns only deterministic schema V1 SQL and table names.
- `src/platform/database/migrate-database.js`: configures connection PRAGMAs and performs transactional, fail-closed migrations.
- `src/platform/database/canonical-json.js`: canonical JSON encoding/digest utility for logical-state evidence.
- `src/platform/database/capacitor-sqlite-connection.js`: native-only wrapper around `SQLiteConnection`/`SQLiteDBConnection`.
- `tests/helpers/node-sqlite-connection.mjs`: test-only adapter around Node's built-in SQLite implementation.
- `src/platform/database/sqlite-spelling-snapshot-store.js`: learner-scoped validated hydration and row-level write primitives.
- `src/platform/database/sqlite-spelling-command-repository.js`: A3 unit of work and exact `{ runCommandTransaction }` public surface.
- `src/platform/database/database-command-gate.js`: one-connection serial queue and pause/drain ownership boundary shared by repository and lifecycle coordinator.
- `src/platform/database/b2-seed.js`: deterministic two-learner profile and Starter snapshot seed data.

### Lifecycle and proof composition

- `src/platform/lifecycle/app-lifecycle-contract.js`: narrow `pause`, `resume`, diagnostic state and disposal contract.
- `src/platform/lifecycle/capacitor-app-lifecycle.js`: native `@capacitor/app` adapter; no web fallback.
- `src/app/database-lifecycle-coordinator.js`: idempotent pause/checkpoint/close and resume/reopen/reload state machine.
- `src/app/create-b2-app-services.js`: native B2 composition root.
- `src/app/b2-proof-controller.js`: deterministic first-launch/relaunch proof orchestration.
- `src/app/App.jsx` and `src/app/app.css`: diagnostic status only; no production visual migration.

### Evidence and CI

- `scripts/prove-b2-ios.mjs`, `scripts/prove-b2-android.mjs`: extend the B1-owned simulator/emulator discipline and produce native proof reports.
- `scripts/lib/b2-evidence.mjs`: strict parsers, canonical evidence shape and shared report validation.
- `scripts/fingerprint-b2-application.mjs`: hashes B2 application inputs while excluding evidence outputs.
- `scripts/build-b2-exit-report.mjs`: composes the two native reports, policy reports and frozen B1 entry authority.
- `reports/b2/`: committed machine-readable iOS, Android, dependency and exit evidence plus diagnostic screenshots.
- `tests/b2-exit-report-builder.test.mjs` and `tests/b2-exit-report.live.mjs`: reject stale commit/fingerprint, missing fields, mismatched logical digests, permissions or lifecycle proof without making pre-evidence `npm test` circular.
- `tests/dependency-policy-resolved.live.mjs`: owns exactly the two fresh resolved-Android dependency assertions outside the default Domain/Web glob.

---

### Task 1: Freeze B1 authority and vendor the A3 producer corpus

**Files:**

- Modify: `provenance/ks2-mastery-gate-a.json`
- Modify: `scripts/verify-vendored-contract.mjs`
- Modify: `tests/vendor-provenance.test.mjs`
- Modify: `package.json`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-command-contracts.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-command-planner.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-command-repository.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-atomicity.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-monster-projection.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-camp-projection.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-revision-projection.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-parent-projection.test.js`
- Create: `vendor/ks2-mastery/tests/spelling-mobile-a3-profile-repository.test.js`

**Interfaces:**

- Consumes: Gate A commit/tree and the already-vendored runtime/content files.
- Produces: `npm run test:upstream:a3`, exact test-only provenance and an invariant that the runtime closure remains exactly 24 files.

- [ ] **Step 1: Write failing provenance tests**

Add the exact producer map to `tests/vendor-provenance.test.mjs`:

```js
const EXPECTED_A3_PRODUCER_TESTS = Object.freeze({
  'tests/spelling-mobile-a3-command-contracts.test.js': 'd4d6eb6032f9022161c6ad6d109e20a7edb575c9edbf085c191d60f16366f93e',
  'tests/spelling-mobile-a3-command-planner.test.js': '5d26781a4fc32e84290215f25016927eb3a500ad433c6e90a782ea87fdf12cda',
  'tests/spelling-mobile-a3-command-repository.test.js': 'efabf2976cbe696cb5986491c4fc0ba8acf57fd5ee356124a92061d7c9cc0fbd',
  'tests/spelling-mobile-a3-atomicity.test.js': 'aa43b0e113397d544b9d0d1cd900f01744673e8e150cc852594b7edef14357b2',
  'tests/spelling-mobile-a3-monster-projection.test.js': 'c995de43c6ab5c3741c2c3ea7904240aebb82e930eeec6a521b1da1a29f4d1ec',
  'tests/spelling-mobile-a3-camp-projection.test.js': '741190527be9a76ffcd8d4d33180981844700f16318e7aa72dc16bdb6bc1bae7',
  'tests/spelling-mobile-a3-revision-projection.test.js': '996c5708d7a0b0167ed9f178f972f9d39f7e4d90bf66c9dd9ded09600141f8ce',
  'tests/spelling-mobile-a3-parent-projection.test.js': '7cb95867ee9762fdf6088bc4191a8ae0362677e8d849559e649c41838d3a9d86',
  'tests/spelling-mobile-a3-profile-repository.test.js': '696bdbf6c98f8361bc7270b3538dce0528e1be380066fa767b3976280bda2482',
});
```

The tests must prove missing, modified, extra and symlinked producer files fail; `runtime.fileCount` stays `24`; runtime `vendor.expectedFileCount` stays `29`; and the test-only count is exactly `9`.

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
node --test tests/vendor-provenance.test.mjs
```

Expected: FAIL because the nine certified producer files and their provenance section do not yet exist.

- [ ] **Step 3: Copy producer bytes from the exact Gate A commit**

Use `git archive` against a verified clone of `https://github.com/fol2/ks2-mastery.git` at commit `4501607a9b58f2fb252b4cce64ba056e6f60c630`, extracting only the nine paths into a temporary directory. Copy the extracted regular files into `vendor/ks2-mastery/tests/`; do not copy from the sibling working tree and do not create links.

Extend the provenance record with:

```json
"producerTests": {
  "root": "vendor/ks2-mastery",
  "fileCount": 9,
  "runtimeAuthority": false,
  "source": "Exact bytes extracted from the frozen Gate A commit for downstream contract testing.",
  "files": {
    "tests/spelling-mobile-a3-command-contracts.test.js": "d4d6eb6032f9022161c6ad6d109e20a7edb575c9edbf085c191d60f16366f93e",
    "tests/spelling-mobile-a3-command-planner.test.js": "5d26781a4fc32e84290215f25016927eb3a500ad433c6e90a782ea87fdf12cda",
    "tests/spelling-mobile-a3-command-repository.test.js": "efabf2976cbe696cb5986491c4fc0ba8acf57fd5ee356124a92061d7c9cc0fbd",
    "tests/spelling-mobile-a3-atomicity.test.js": "aa43b0e113397d544b9d0d1cd900f01744673e8e150cc852594b7edef14357b2",
    "tests/spelling-mobile-a3-monster-projection.test.js": "c995de43c6ab5c3741c2c3ea7904240aebb82e930eeec6a521b1da1a29f4d1ec",
    "tests/spelling-mobile-a3-camp-projection.test.js": "741190527be9a76ffcd8d4d33180981844700f16318e7aa72dc16bdb6bc1bae7",
    "tests/spelling-mobile-a3-revision-projection.test.js": "996c5708d7a0b0167ed9f178f972f9d39f7e4d90bf66c9dd9ded09600141f8ce",
    "tests/spelling-mobile-a3-parent-projection.test.js": "7cb95867ee9762fdf6088bc4191a8ae0362677e8d849559e649c41838d3a9d86",
    "tests/spelling-mobile-a3-profile-repository.test.js": "696bdbf6c98f8361bc7270b3538dce0528e1be380066fa767b3976280bda2482"
  }
}
```

- [ ] **Step 4: Extend the fail-closed verifier and package script**

`verify-vendored-contract.mjs` must classify the original 29 paths as runtime/content authority and the new nine paths as test-only authority, hash both sets, reject any other vendor path, and return both counts. Add:

```json
"test:upstream:a3": "node --test vendor/ks2-mastery/tests/spelling-mobile-a3-*.test.js"
```

to `package.json`.

- [ ] **Step 5: Run the producer and provenance gates**

Run:

```bash
npm run verify:vendor
npm run test:upstream:a3
node --test tests/vendor-provenance.test.mjs
git diff --check
```

Expected: all commands PASS; the producer corpus runs against `vendor/ks2-mastery/shared` and `vendor/ks2-mastery/content`; the runtime count remains 24 and no sibling checkout is read.

- [ ] **Step 6: Commit the certified producer corpus**

```bash
git add package.json provenance/ks2-mastery-gate-a.json scripts/verify-vendored-contract.mjs tests/vendor-provenance.test.mjs vendor/ks2-mastery/tests
git commit -m "test: certify A3 producer corpus"
```

### Task 2: Install and compile the exact native SQLite and lifecycle plugins

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `capacitor.config.json`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/res/xml/backup_rules.xml`
- Create: `android/app/src/main/res/xml/data_extraction_rules.xml`
- Modify: `android/app/capacitor.build.gradle`
- Modify: `android/capacitor.settings.gradle`
- Modify: `android/gradle/dependency-locks/*.lockfile`
- Modify: `android/gradle/verification-metadata.xml`
- Modify: `ios/App/CapApp-SPM/Package.swift`
- Modify: `ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
- Modify: `scripts/test-android.mjs`
- Modify: `tests/android-project-contract.test.mjs`
- Modify: `tests/ios-project-contract.test.mjs`
- Modify: `tests/native-wrapper-contract.test.mjs`
- Create: `tests/b2-native-plugin-build-policy.test.mjs`
- Create: `reports/b2/native-plugin-build.json`

**Interfaces:**

- Consumes: exact npm versions/integrities and the B1 dependency policy/audit pipeline.
- Produces: synced native inputs plus a machine-readable build report covering exact npm packages, iOS unsigned compile, Android debug/unsigned-release compile, permissions, backup rules, Info.plist and entitlements. Final dependency/privacy approval belongs to Task 3.

- [ ] **Step 1: Write failing plugin-policy tests**

The focused tests must require:

```js
const REQUIRED_PLUGINS = Object.freeze({
  '@capacitor-community/sqlite': {
    version: '8.1.0',
    integrity: 'sha512-yhKZDAVPDPcM3QE6UGB3LXyV25a6Rve1SjZ1aUpTE0E2isnYTVM0PG9+JOI241f+NdsHzPTE7ESJiYSqKsKnuA==',
  },
  '@capacitor/app': {
    version: '8.1.0',
    integrity: 'sha512-MlmttTOWHDedr/G4SrhNRxsXMqY+R75S4MM4eIgzsgCzOYhb/MpCkA5Q3nuOCfL1oHm26xjUzqZ5aupbOwdfYg==',
  },
});
```

They must reject caret/range pins, `jeep-sqlite` imports or initialisation, a `server.url`, encryption/biometric config set true, missing permission removals, any packaged permission, Android backup enabled or missing legacy/current all-domain exclusion rules, any new iOS usage-description key or entitlement, or a build report without the iOS unsigned Simulator, Android debug and Android unsigned release compile results.

- [ ] **Step 2: Run the policy tests and record RED**

Run:

```bash
node --test tests/b2-native-plugin-build-policy.test.mjs tests/android-project-contract.test.mjs tests/ios-project-contract.test.mjs tests/native-wrapper-contract.test.mjs
```

Expected: FAIL because neither plugin is installed and native generated inputs/build evidence do not contain them.

- [ ] **Step 3: Install exact packages and configure explicit no-encryption mode**

Run:

```bash
npm install --save-exact @capacitor-community/sqlite@8.1.0 @capacitor/app@8.1.0
```

Set `capacitor.config.json` plugin configuration exactly to:

```json
"plugins": {
  "CapacitorSQLite": {
    "iosDatabaseLocation": "Library/CapacitorDatabase",
    "iosIsEncryption": false,
    "iosBiometric": { "biometricAuth": false },
    "androidIsEncryption": false,
    "androidBiometric": { "biometricAuth": false }
  }
}
```

Do not add `server`, `webDir` changes, `jeep-sqlite` initialisation or a web adapter.

Add `xmlns:tools="http://schemas.android.com/tools"` to the application manifest and these direct children of `<manifest>`:

```xml
<uses-permission android:name="android.permission.USE_BIOMETRIC" tools:node="remove" />
<uses-permission android:name="android.permission.USE_FINGERPRINT" tools:node="remove" />
```

Set the application to `android:allowBackup="false"`, `android:fullBackupContent="@xml/backup_rules"` and `android:dataExtractionRules="@xml/data_extraction_rules"`. Both XML rule files must exclude `root`, `file`, `database`, `sharedpref` and `external` domains; the API 31+ rules must also exclude the corresponding `device_*` domains for cloud backup and device transfer. Inspect the merged packaged manifest and packaged XML resources through Android build tools; source-text checks alone are insufficient.

- [ ] **Step 4: Materialise native inputs and certify the first Android resolution**

Run in this order:

```bash
npm run build
npx --no-install cap sync
node scripts/resolve-android-dependencies.mjs --write
```

The write-mode resolver must run before any Android compile. It is the only bootstrap exception to the fail-closed committed dependency gate: it resolves the newly synced plugin graph, rewrites the three Gradle lockfiles and SHA-256 verification metadata, then immediately re-reads them and proves complete coverage of the resolved component and artefact inventory. Review the resulting diff and reject unexpected repositories, coordinates, dynamic versions or non-SHA-256 verification entries before continuing.

- [ ] **Step 5: Compile both platforms against the materialised closure**

Run:

```bash
npm run test:ios
npm run test:android
```

Extend the existing Android wrapper's Gradle task list to `testDebugUnitTest`, `assembleDebug`, `assembleRelease`; keep permission inspection against the installed debug APK and record `releaseCompiled: true`, `releaseSigned: false`. Expected: SwiftPM resolves and the unsigned iOS Simulator app builds; Android unit tests, debug APK and unsigned release compile build; the packaged Android permission arrays remain empty. If either native build fails or a permission remains, stop this task and repair the candidate without changing plugin, platform manager or policy.

- [ ] **Step 6: Commit the exact cross-platform native build**

Write `reports/b2/native-plugin-build.json` from the validated npm/native build inputs, then run:

```bash
node --test tests/b2-native-plugin-build-policy.test.mjs tests/android-project-contract.test.mjs tests/ios-project-contract.test.mjs tests/native-wrapper-contract.test.mjs
git diff --check
git add package.json package-lock.json capacitor.config.json android ios scripts/test-android.mjs tests/b2-native-plugin-build-policy.test.mjs tests/android-project-contract.test.mjs tests/ios-project-contract.test.mjs tests/native-wrapper-contract.test.mjs reports/b2/native-plugin-build.json
git commit -m "build: compile B2 native plugins"
```

### Task 3: Certify the plugin dependency, privacy and licence closure

**Files:**

- Modify: `config/dependency-policy.json`
- Modify: `config/third-party-notices-overrides.json`
- Modify: `scripts/audit-dependencies.mjs`
- Modify: `scripts/certify-android-dependencies.mjs`
- Modify: `scripts/generate-third-party-notices.mjs`
- Modify: `docs/compliance/sdk-privacy-register.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `tests/dependency-policy.test.mjs`
- Create: `tests/b2-native-plugin-policy.test.mjs`
- Create: `reports/b2/native-plugin-audit.json`
- Create: `reports/b2/dependency-audit.json`

**Interfaces:**

- Consumes: Task 2's exact native build report and resolved npm/SPM/Maven inputs.
- Produces: conditionally approved B2-only plugin closure with complete source/licence/privacy/export/permission/backup evidence.

- [ ] **Step 1: Write failing dependency/privacy policy tests**

Require the exact SHA-256 of `reports/b2/native-plugin-build.json`, exact resolution-kind pins, registered sources, npm integrities, Maven locks/checksums, consistent component/artefact totals, preserved B1 audit bytes, honest SQLCipher/export fields, merged Android permission/backup evidence and zero iOS usage/entitlement additions.

- [ ] **Step 2: Run the focused policy test and record RED**

```bash
node --test tests/b2-native-plugin-policy.test.mjs tests/dependency-policy.test.mjs
```

Expected: FAIL because the new transitive closure is not registered or certified.

- [ ] **Step 3: Pin and audit the complete dependency closure**

Generalise the B1 audit from one SwiftPM package to all resolved identities. Preserve `reports/b1/dependency-audit.json` byte-for-byte as frozen entry evidence and write the expanded current closure only to `reports/b2/dependency-audit.json`. The B2 report must bind the resolution kind plus exact branch/revision or exact version/revision for `capacitor-swift-pm`, `SQLCipher.swift`, `ZIPFoundation` and every other resolved identity; every Maven component/artefact; npm integrity; source URL; licence; packaged status; privacy role; and restricted/export classification. Re-run the resolver without write mode and certify that Task 2's committed locks and verification metadata reproduce the same closure; Task 3 audits those files but does not bootstrap or silently rewrite them.

Update the policy to permit only the newly observed official sources:

```text
https://github.com/capacitor-community/sqlite.git
https://github.com/ionic-team/capacitor-plugins.git
https://github.com/ionic-team/capacitor-swift-pm.git
https://github.com/sqlcipher/SQLCipher.swift.git
https://github.com/weichsel/ZIPFoundation.git
google()
mavenCentral()
```

Keep exact resolved values generated by the successful build; do not replace them with version ranges in evidence. Regenerate notices and dependency reports through existing scripts. If the Task 2 Android locks/checksums need to change, return to Task 2's write-and-review step instead of mutating them during certification.

- [ ] **Step 4: Record honest privacy, permission and export evidence**

The SDK/privacy register and `reports/b2/native-plugin-audit.json` must state:

```json
{
  "sqliteMode": "no-encryption",
  "webFallbackInitialised": false,
  "androidPackagedPermissions": [],
  "iosAddedUsageDescriptionKeys": [],
  "iosAddedEntitlements": [],
  "androidBackupEnabled": false,
  "androidDataExtraction": "all-domains-excluded-until-c2",
  "sqlCipherPackaged": true,
  "applicationEncryptionAtRestProved": false,
  "usEncryptionExportClassification": "unresolved-before-store-release",
  "approval": "B2-proof-only"
}
```

Do not add `ITSAppUsesNonExemptEncryption` in either direction.

- [ ] **Step 5: Run the complete plugin approval gate**

Run:

```bash
npm ci
npm run build
npm run native:sync:check
npm run test:ios
npm run test:android
npm run certify:android
npm run audit:dependencies
npm run generate:notices
node --test tests/b2-native-plugin-policy.test.mjs tests/dependency-policy.test.mjs tests/android-project-contract.test.mjs tests/ios-project-contract.test.mjs tests/native-wrapper-contract.test.mjs
git diff --check
```

Expected: all commands PASS, the audit count is internally consistent across JSON/register/notices, and no permission or undeclared source exists.

- [ ] **Step 6: Commit the conditionally approved native dependency closure**

```bash
git add android/gradle config scripts/audit-dependencies.mjs scripts/certify-android-dependencies.mjs scripts/generate-third-party-notices.mjs docs/compliance THIRD_PARTY_NOTICES.md tests/dependency-policy.test.mjs tests/b2-native-plugin-policy.test.mjs reports/b2/native-plugin-audit.json reports/b2/dependency-audit.json
git commit -m "build: certify B2 plugin closure"
```

### Task 4: Define the SQL port, canonical encoding and native/test adapters

**Files:**

- Create: `src/platform/database/sql-connection-contract.js`
- Create: `src/platform/database/canonical-json.js`
- Create: `src/platform/database/capacitor-sqlite-connection.js`
- Create: `tests/helpers/node-sqlite-connection.mjs`
- Create: `tests/sql-connection-contract.test.mjs`
- Create: `tests/canonical-json.test.mjs`
- Create: `tests/capacitor-sqlite-connection.test.mjs`

**Interfaces:**

- Consumes: native SQLite plugin connection methods and Node `DatabaseSync` in tests.
- Produces: `assertSqlConnection(value)`, `createCapacitorSqliteConnection(options)`, `canonicalJson(value)` and asynchronous `canonicalJsonSha256(value)`.

- [ ] **Step 1: Write failing port, canonical JSON and fake-plugin tests**

Define the exact application-owned port:

```js
{
  open(), close(), execute(sql, values), query(sql, values),
  begin(), commit(), rollback(), isTransactionActive()
}
```

Every method is own, enumerable and asynchronous. Reject extra/hidden/accessor methods and non-Promise returns. Canonical JSON tests cover nested key order, preserved array order and rejection of cycles/non-finite/unsupported values. Fake-plugin tests assert exact native call arguments and one close path.

- [ ] **Step 2: Run focused tests and record RED**

```bash
node --test tests/sql-connection-contract.test.mjs tests/canonical-json.test.mjs tests/capacitor-sqlite-connection.test.mjs
```

Expected: FAIL because the port, canonical encoder and adapters do not exist.

- [ ] **Step 3: Implement strict validation and canonical JSON**

`assertSqlConnection` inspects property descriptors without invoking accessors and returns the same validated object. `canonicalJson` rejects cycles, non-finite numbers, `undefined`, functions, symbols, bigint and non-plain objects; it sorts object keys lexicographically and preserves array order. `canonicalJsonSha256` hashes UTF-8 through `globalThis.crypto.subtle.digest('SHA-256', ...)` and imports no Node built-in into Vite.

- [ ] **Step 4: Implement Node and Capacitor adapters**

The Node test adapter wraps `DatabaseSync` behind the async port. The native adapter requires `Capacitor.isNativePlatform() === true`, creates `SQLiteConnection(CapacitorSQLite)` then `createConnection('ks2-spelling', false, 'no-encryption', 1, false)`. Parameterised writes call `database.run(sql, values, false)`; parameter-free statements call `database.execute(sql, false)`; queries call `database.query`; transaction calls map exactly; close calls only `manager.closeConnection('ks2-spelling', false)` once. Never initialise `jeep-sqlite` or call `database.close()` as a second native close.

- [ ] **Step 5: Run focused and bundle gates**

```bash
node --test tests/sql-connection-contract.test.mjs tests/canonical-json.test.mjs tests/capacitor-sqlite-connection.test.mjs
npm run lint
npm run build
git diff --check
```

Expected: PASS and no `node:sqlite` import in the Vite bundle.

- [ ] **Step 6: Commit the SQL port and adapters**

```bash
git add src/platform/database/sql-connection-contract.js src/platform/database/canonical-json.js src/platform/database/capacitor-sqlite-connection.js tests/helpers/node-sqlite-connection.mjs tests/sql-connection-contract.test.mjs tests/canonical-json.test.mjs tests/capacitor-sqlite-connection.test.mjs
git commit -m "feat: add native SQL connection port"
```

### Task 5: Add schema V1 and the transactional migration runner

**Files:**

- Create: `src/platform/database/schema-v1.js`
- Create: `src/platform/database/migrate-database.js`
- Create: `tests/sqlite-schema.test.mjs`
- Create: `tests/sqlite-migration-rollback.test.mjs`

**Interfaces:**

- Consumes: the Task 4 SQL port.
- Produces: `SCHEMA_VERSION === 1`, `DATABASE_NAME === 'ks2-spelling'`, `SCHEMA_V1_STATEMENTS` and `configureAndMigrateDatabase(connection, options)`.

- [ ] **Step 1: Write failing schema/migration tests**

Require exact PRAGMAs, all eight tables, keys/foreign keys/check constraints, deterministic fresh creation, idempotent reopen, unknown `user_version > 1` failure, rollback of DDL/data after injected failure, rollback after failed `integrity_check` and no automatic file deletion/reset.

- [ ] **Step 2: Run focused tests and record RED**

```bash
node --test tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs
```

Expected: FAIL because schema/migration modules do not exist.

- [ ] **Step 3: Implement exact schema V1**

`SCHEMA_V1_STATEMENTS` uses these exact definitions:

```sql
CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;
CREATE TABLE learner_profiles (learner_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, year_group TEXT NOT NULL, goal INTEGER NOT NULL CHECK (goal >= 0), colour TEXT NOT NULL, created_at INTEGER NOT NULL CHECK (created_at >= 0), updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)) WITHOUT ROWID;
CREATE TABLE spelling_aggregates (learner_id TEXT PRIMARY KEY REFERENCES learner_profiles(learner_id) ON DELETE CASCADE, snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version = 1), revision INTEGER NOT NULL CHECK (revision >= 0), pack_id TEXT NOT NULL, catalogue_id TEXT NOT NULL, granted_entitlement_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL CHECK (updated_at >= 0)) WITHOUT ROWID;
CREATE TABLE spelling_subject_states (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, state_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE spelling_practice_sessions (learner_id TEXT PRIMARY KEY REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, session_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')), state_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE spelling_events (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, event_id TEXT NOT NULL, sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0), created_at INTEGER NOT NULL CHECK (created_at >= 0), event_json TEXT NOT NULL, PRIMARY KEY (learner_id, event_id), UNIQUE (learner_id, sequence_no)) WITHOUT ROWID;
CREATE TABLE spelling_monster_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, reward_track_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, reward_track_id)) WITHOUT ROWID;
CREATE TABLE spelling_camp_states (learner_id TEXT NOT NULL REFERENCES spelling_aggregates(learner_id) ON DELETE CASCADE, pack_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (learner_id, pack_id)) WITHOUT ROWID;
```

Add no redundant secondary index and no Parent/commerce/download/audio/backup table.

- [ ] **Step 4: Configure and migrate transactionally**

Require `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`. For V0, begin, execute ordered schema, set `user_version=1`, run `foreign_key_check` and `integrity_check`, invoke failure injection after every statement and before commit, then commit. For V1, verify without rewrite. Any newer/other version closes and throws `sqlite_schema_version_unsupported`. Any in-transaction failure rolls back, proves transaction inactive, preserves the file and rethrows without reset.

- [ ] **Step 5: Run focused database gates**

```bash
node --test tests/sql-connection-contract.test.mjs tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs
npm run lint
git diff --check
```

Expected: PASS; failure returns the exact pre-migration logical/schema digest.

- [ ] **Step 6: Commit schema and migration**

```bash
git add src/platform/database/schema-v1.js src/platform/database/migrate-database.js tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs
git commit -m "feat: add transactional SQLite schema"
```

### Task 6: Add the command gate, deterministic seed and snapshot store

**Files:**

- Create: `src/platform/database/database-command-gate.js`
- Create: `src/platform/database/b2-seed.js`
- Create: `src/platform/database/sqlite-spelling-snapshot-store.js`
- Create: `tests/helpers/b2-database-harness.mjs`
- Create: `tests/database-command-gate.test.mjs`
- Create: `tests/sqlite-spelling-snapshot-store.test.mjs`

**Interfaces:**

- Consumes: Task 5 schema/connection, frozen A3 snapshot validator and certified Starter catalogue.
- Produces: `createDatabaseCommandGate()`, `seedB2Learners(connection)` and internal `createSQLiteSpellingSnapshotStore({ connection, cataloguesById })` with exactly `read(learnerId)`, `writeSubjectState(learnerId, state)`, `writePracticeSession(learnerId, session)`, `appendEvents(learnerId, existingEventLog, appendedEvents)`, `syncMonsters(learnerId, states)`, `syncCamp(learnerId, states)` and `compareAndSetAggregate(learnerId, expectedRevision, plan, nowMs)`.

- [ ] **Step 1: Write failing gate, seed and hydration tests**

Seed exactly:

```js
const B2_LEARNERS = Object.freeze([
  Object.freeze({
    learnerId: 'learner-a', nickname: 'Ada', yearGroup: 'Y3', goal: 10,
    colour: '#2E7D8A', createdAt: 1_768_478_400_000, updatedAt: 1_768_478_400_000,
  }),
  Object.freeze({
    learnerId: 'learner-b', nickname: 'Ben', yearGroup: 'Y5', goal: 10,
    colour: '#A7633B', createdAt: 1_768_478_400_000, updatedAt: 1_768_478_400_000,
  }),
]);
```

Both initial snapshots use schema `1`, revision `0`, `packId: 'ks2-core'`, `catalogueId: 'ks2-core:starter'`, no entitlements, empty progress/session/events/Monster/Camp and the exact A3 subject envelope. Tests also cover one active plus one queued gate operation followed by pause, seed idempotency, changed-seed rejection, foreign learner rejection, non-canonical JSON, event order gaps, complete snapshot round-trip, and rejection of every write helper when `connection.isTransactionActive()` is false.

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
node --test tests/database-command-gate.test.mjs tests/sqlite-spelling-snapshot-store.test.mjs
```

Expected: FAIL because the gate, seed and snapshot store do not exist.

- [ ] **Step 3: Implement the one-connection command gate**

`createDatabaseCommandGate()` owns these internal methods:

```js
{
  run(executor),
  pauseAndDrain(),
  resume(),
  isAccepting(),
  waitForIdle()
}
```

`run` uses an explicit FIFO queue while accepting work. Once pause starts, it atomically marks the gate non-accepting, rejects every accepted-but-not-started executor with stable code `sqlite_commands_paused`, waits only for the one executor already owning the connection, and then reports idle. No queued executor may start after the connection is checkpointed or closed. A rejected active executor still releases ownership. Resume is allowed only after the active executor settles and the old queue is empty. This object is an application-internal collaborator; it is not exposed through the A3 repository surface.

- [ ] **Step 4: Implement deterministic seed and snapshot hydration**

`seedB2Learners` runs in one transaction, uses insert-if-absent semantics, then validates existing rows byte-for-byte against the seed. It must never overwrite a changed learner. Hydration queries by the requested `learner_id` in every table, reconstructs:

```js
{
  schemaVersion,
  learnerId,
  revision,
  packId,
  catalogueId,
  grantedEntitlementIds,
  subjectState,
  practiceSession,
  eventLog,
  monsterStateByRewardTrackId,
  campStateByPackId,
}
```

Parse every JSON field, reject non-canonical bytes, sort events by `sequence_no ASC`, require a contiguous zero-based sequence, then pass the result through the frozen A3 snapshot validator before returning it.

- [ ] **Step 5: Run the focused snapshot-store gate**

```bash
node --test tests/database-command-gate.test.mjs tests/sqlite-spelling-snapshot-store.test.mjs tests/sqlite-schema.test.mjs
npm run lint
git diff --check
```

Expected: PASS; queued work is rejected before close and both learner snapshots validate byte-for-byte.

- [ ] **Step 6: Commit the gate and snapshot store**

```bash
git add src/platform/database/database-command-gate.js src/platform/database/b2-seed.js src/platform/database/sqlite-spelling-snapshot-store.js tests/helpers/b2-database-harness.mjs tests/database-command-gate.test.mjs tests/sqlite-spelling-snapshot-store.test.mjs
git commit -m "feat: add learner snapshot store"
```

### Task 7: Implement the exact SQLite A3 command transaction

**Files:**

- Create: `src/platform/database/sqlite-spelling-command-repository.js`
- Create: `tests/sqlite-command-repository.test.mjs`
- Modify: `src/platform/database/sqlite-spelling-snapshot-store.js`
- Modify: `tests/helpers/b2-database-harness.mjs`

**Interfaces:**

- Consumes: Task 6 gate/store, A3 `validateSpellingCommandRepository`, `validateSpellingCommandSnapshotV1`, `validateSpellingCommandPlanV1`, `canonicalGuardianDay`, `SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS` and injected clock/failure ports.
- Produces: `createSQLiteSpellingCommandRepository(options)` returning exactly `{ runCommandTransaction }`.

- [ ] **Step 1: Write failing repository transaction tests**

Require frozen repository validation, exact one-method surface, invalid planner/learner rejection, exact frozen planner context, clock sampled once per attempt, all durable targets, changed-false behaviour, conflict retry/exhaustion, rollback and transient effects only after commit.

- [ ] **Step 2: Run focused tests and record RED**

```bash
node --test tests/sqlite-command-repository.test.mjs
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the exact transaction/retry sequence**

For each attempt from `1` through `SPELLING_COMMAND_MAX_CONFLICT_ATTEMPTS`:

```text
gate.run
  -> connection.begin
  -> hydrate and validate a fresh snapshot
  -> sample and validate nowMs once
  -> derive todayGuardianDay through the frozen canonicalGuardianDay(nowMs)
  -> await planner(defensiveClone(snapshot), Object.freeze({ nowMs, todayGuardianDay }))
  -> validate the complete plan against the active catalogue and nowMs
  -> changed:false: commit read-only transaction and return no transient effects
  -> write subject state
  -> checkpoint after-subject-state
  -> upsert/delete latest practice session
  -> checkpoint after-practice-session
  -> insert only validated appended events; verify complete next-event-log identity
  -> checkpoint after-events
  -> synchronise Monster rows for this learner only
  -> checkpoint after-monster-state
  -> synchronise Camp rows for this learner only
  -> checkpoint after-camp-state
  -> compare-and-set aggregate revision and immutable pack/catalogue/entitlement envelope
  -> checkpoint after-revision
  -> rehydrate the staged snapshot inside the transaction and compare canonical logical bytes with the validated next plan
  -> checkpoint before-commit
  -> commit once
  -> return committed result plus defensive-cloned transient effects
```

If compare-and-set changes zero rows, roll back the entire attempt and retry from a fresh read. At attempt three, throw code `spelling_revision_conflict`. Any other error rolls back if active, proves the transaction is inactive, and rethrows without retry. A rollback error is attached as `cause` but cannot replace the original stable error code.

- [ ] **Step 4: Implement learner-scoped synchronisation**

Use parameterised statements for every value. Monster/Camp synchronisation deletes only rows whose `(learner_id, key)` is absent from the validated next map, then upserts canonical state. Event insertion assigns each genuinely appended event the next contiguous `sequence_no` in plan order and uses `(learner_id, event_id)` primary-key collision handling: exact canonical replay is accepted without insertion; different canonical content throws `spelling_event_id_collision`. No SQL statement may omit the learner predicate when updating or deleting learner state.

- [ ] **Step 5: Run focused repository and upstream gates**

Run:

```bash
npm run test:upstream:a3
node --test tests/sqlite-command-repository.test.mjs tests/sqlite-spelling-snapshot-store.test.mjs tests/sqlite-schema.test.mjs
npm run lint
git diff --check
```

Expected: all PASS; repository surface is exact; no upstream A3 producer behaviour changes.

- [ ] **Step 6: Commit the SQLite command repository**

```bash
git add src/platform/database/sqlite-spelling-command-repository.js src/platform/database/sqlite-spelling-snapshot-store.js tests/helpers/b2-database-harness.mjs tests/sqlite-command-repository.test.mjs
git commit -m "feat: persist A3 commands atomically"
```

### Task 8: Prove adapter parity, atomicity and two-learner isolation

**Files:**

- Create: `tests/fixtures/b2-command-scenarios.mjs`
- Create: `tests/sqlite-adapter-parity.test.mjs`
- Create: `tests/sqlite-atomicity.test.mjs`
- Create: `tests/sqlite-multi-learner.test.mjs`
- Modify: `tests/helpers/b2-database-harness.mjs`

**Interfaces:**

- Consumes: frozen in-memory A3 repository, SQLite repository, canonical logical snapshot digest and exact failure checkpoint port.
- Produces: one shared scenario matrix proving semantic parity and all-or-nothing behaviour without comparing physical SQLite bytes.

- [ ] **Step 1: Write the shared deterministic scenario matrix**

Define the exact progress-changing Starter Smart round already characterised by A3:

```js
export const B2_COMMANDS = Object.freeze([
  Object.freeze({
    type: 'start-session',
    payload: Object.freeze({
      mode: 'smart', yearFilter: 'core', length: 1,
      practiceOnly: false, words: Object.freeze(['ks2-core:answer']),
    }),
  }),
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'wrong' }) }),
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'answer' }) }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
  Object.freeze({ type: 'submit-answer', payload: Object.freeze({ typed: 'answer' }) }),
  Object.freeze({ type: 'continue-session', payload: Object.freeze({}) }),
]);
```

Use repository timestamps `1_768_478_400_000` through `1_768_478_400_005`, one per successful command. Every injected rollback attempt against command index `4` samples the same index-4 timestamp and does not advance the successful-command clock. Use the exact deterministic Mulberry32-style `randomFrom(42)` source from the frozen A3 producer test; a constant zero source is forbidden because it can create an invalid all-zero session identity.

- [ ] **Step 2: Write failing parity, atomicity and isolation tests**

Require:

- identical canonical plans and final logical snapshots between the memory and SQLite adapters for all six commands;
- one successful all-target mutation;
- no-change plan leaves the complete database logical digest unchanged;
- planner throw and invalid plan leave it unchanged;
- each of the seven failure checkpoints leaves it unchanged;
- stale revision retries from a fresh snapshot and succeeds when the conflict clears;
- three conflicts throw the exact stable error with no mutation;
- same-learner concurrent calls serialise deterministically;
- learner A's complete round leaves learner B's digest unchanged;
- attempts to return learner B data from learner A's planner fail closed;
- Starter retains `packId: 'ks2-core'`, no entitlements and empty Camp rows;
- Monster rows contain learner A's spelling-derived track state and no Parent sentinel;
- SQLite schema and every stored JSON value contain none of `parent`, `parentProgress`, `monsterRatio`, `campAnalytics` or seeded redaction sentinel values.

- [ ] **Step 3: Run the new tests and record RED**

Run:

```bash
node --test tests/sqlite-adapter-parity.test.mjs tests/sqlite-atomicity.test.mjs tests/sqlite-multi-learner.test.mjs
```

Expected: at least one test FAIL where repository behaviour or the test harness does not yet satisfy the complete matrix.

- [ ] **Step 4: Complete the minimal repository/test-harness behaviour**

Repair only behaviour exposed by the matrix. Do not add profile CRUD, Parent read models, Full entitlement state or Camp UI. Every injected conflict must occur before commit and every retry must invoke the planner again with a freshly cloned snapshot and a newly sampled clock value. The atomic failure matrix must target command index `4`, the second correct Smart answer, because it durably changes item progress, the active session and Monster projection; a practice-only command is not acceptable atomic-progress evidence.

- [ ] **Step 5: Run the complete database contract gate**

Run:

```bash
npm run test:upstream:a3
node --test tests/sql-connection-contract.test.mjs tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs tests/sqlite-command-repository.test.mjs tests/sqlite-adapter-parity.test.mjs tests/sqlite-atomicity.test.mjs tests/sqlite-multi-learner.test.mjs
npm run lint
git diff --check
```

Expected: all PASS and the canonical memory/SQLite snapshot SHA-256 values match.

- [ ] **Step 6: Commit parity and failure-matrix proof**

```bash
git add src/platform/database tests/fixtures/b2-command-scenarios.mjs tests/helpers/b2-database-harness.mjs tests/sqlite-adapter-parity.test.mjs tests/sqlite-atomicity.test.mjs tests/sqlite-multi-learner.test.mjs
git commit -m "test: prove SQLite command atomicity"
```

### Task 9: Add the native lifecycle coordinator

**Files:**

- Create: `src/platform/lifecycle/app-lifecycle-contract.js`
- Create: `src/platform/lifecycle/capacitor-app-lifecycle.js`
- Create: `src/app/database-lifecycle-coordinator.js`
- Create: `tests/app-lifecycle-contract.test.mjs`
- Create: `tests/database-lifecycle-coordinator.test.mjs`

**Interfaces:**

- Consumes: `@capacitor/app` pause/resume/appStateChange events, SQL connection factory, migration runner and database command gate.
- Produces: `createCapacitorAppLifecycle()`, `createDatabaseLifecycleCoordinator(options)` with `start()`, `dispose()`, `getDiagnosticState()` and idempotent async pause/resume handling.

- [ ] **Step 1: Write failing lifecycle contract/state-machine tests**

The lifecycle adapter contract is exactly:

```js
{
  onPause(listener),
  onResume(listener),
  onStateChange(listener),
  getState(),
  dispose()
}
```

Tests must cover listener handle removal, duplicate pause/resume, resume-before-pause, pause while one transaction is active plus one already-queued command, deterministic rejection of that queued command before close, a rejected active transaction, checkpoint failure, close failure, reopen/migration failure, disposal during transition and an event after disposal. State must never be cleared or reset after a failure.

- [ ] **Step 2: Run the lifecycle tests and record RED**

Run:

```bash
node --test tests/app-lifecycle-contract.test.mjs tests/database-lifecycle-coordinator.test.mjs
```

Expected: FAIL because neither lifecycle boundary exists.

- [ ] **Step 3: Implement the native lifecycle adapter**

Require `Capacitor.isNativePlatform() === true`; otherwise throw `native_lifecycle_required`. Register `App.addListener('pause', ...)`, `App.addListener('resume', ...)` and `App.addListener('appStateChange', ...)`. Treat `pause` and `resume` as the canonical inputs; `appStateChange` only appends diagnostic evidence. `dispose()` awaits each returned handle's `remove()` exactly once and makes later callbacks inert.

- [ ] **Step 4: Implement the idempotent coordinator**

Use states `starting`, `active`, `pausing`, `paused`, `resuming`, `failed`, `disposed`. On pause:

```text
mark commands non-accepting
  -> wait for the currently owned command only
  -> if still connected, query PRAGMA wal_checkpoint(PASSIVE)
  -> close the exact connection
  -> enter paused
```

On resume:

```text
create/open the exact connection
  -> configure PRAGMAs and verify/migrate schema
  -> rehydrate and validate the selected learner's active session
  -> resume the command gate
  -> enter active
```

The native event callback starts the async transition but correctness never assumes the OS waits for its completion. A kill before close remains safe because every command already committed or rolled back. Duplicate/out-of-order events join the in-flight transition or become a no-op. Failure enters `failed`, preserves SQLite bytes, keeps commands paused, and can be retried by a later resume; it never deletes or recreates the database.

- [ ] **Step 5: Run lifecycle and database gates**

Run:

```bash
node --test tests/app-lifecycle-contract.test.mjs tests/database-lifecycle-coordinator.test.mjs tests/sqlite-atomicity.test.mjs tests/sqlite-multi-learner.test.mjs
npm run lint
npm run build
git diff --check
```

Expected: all PASS; no web lifecycle fallback enters the built native composition.

- [ ] **Step 6: Commit the lifecycle boundary**

```bash
git add src/platform/lifecycle src/app/database-lifecycle-coordinator.js tests/app-lifecycle-contract.test.mjs tests/database-lifecycle-coordinator.test.mjs
git commit -m "feat: coordinate SQLite app lifecycle"
```

### Task 10: Build the deterministic B2 persistence proof shell

**Files:**

- Create: `src/app/create-b2-app-services.js`
- Create: `src/app/b2-proof-controller.js`
- Modify: `src/app/create-app-services.js`
- Modify: `src/app/App.jsx`
- Modify: `src/app/app.css`
- Modify: `src/main.jsx`
- Create: `tests/b2-proof-controller.test.mjs`
- Modify: `tests/app-shell.test.mjs`

**Interfaces:**

- Consumes: native database/lifecycle adapters, exact command scenario, two-learner seed and `app_metadata` proof record.
- Produces: deterministic first-launch/relaunch state machine and diagnostic DOM states `Preparing local proof`, `Background test ready`, `Ready for relaunch`, `Resumed safely`, `B2 proof complete` or `B2 proof needs attention`.

- [ ] **Step 1: Write failing proof-controller and shell tests**

Test the controller entirely through injected repository, connection/lifecycle and proof-record ports. Require exact transition order:

```text
fresh
  -> inject one V0-to-V1 migration failure and prove user_version/schema/data rolled back
  -> rerun V0-to-V1 migration successfully
  -> seed learner-a and learner-b
  -> start one fixed Smart Starter session for learner-a
  -> submit one wrong answer and enter retry
  -> submit the correction and clear retry
  -> continue to the repeated progress-bearing card (revision 4)
  -> background-test-ready
  -> observe canonical pause then resume
  -> persist ready-for-relaunch with active session ID/revision/digests
  -> process terminates externally
  -> new process reads ready-for-relaunch
  -> validate the exact active session and learner-B unchanged digest
  -> inject each of the seven A3 transaction failures against the second correct answer and prove the revision-4 digest unchanged after every rollback
  -> commit the second correct answer (revision 5, progress/active session/Monster mutation)
  -> continue to completed session and event log (revision 6)
  -> validate final state and persist complete evidence
```

Tests must prove a duplicate controller start does not replay commands, stale/corrupt proof metadata fails closed, a committed command is never replayed after relaunch, learner B never changes, and error rendering includes no raw learner state or typed answer.

- [ ] **Step 2: Run focused tests and record RED**

Run:

```bash
node --test tests/b2-proof-controller.test.mjs tests/app-shell.test.mjs
```

Expected: FAIL because B1 still exposes disabled fake database ports and no B2 state machine exists.

- [ ] **Step 3: Implement native-only B2 composition**

`createB2AppServices` must own startup in this exact order: create/open the raw native connection; if and only if `user_version === 0`, run the one injected migration failure and verify V0/no V1 objects; run the normal migration; seed and validate both learners; then construct the command gate/repository and start the lifecycle coordinator. A relaunch at schema V1 skips the injected fresh-migration path. It loads only the certified Starter catalogue and requires 20 items. The normal B1 fake composition remains importable for its existing contract tests, but `main.jsx` selects B2 native composition only when `Capacitor.isNativePlatform()` is true. Browser execution renders a calm diagnostic error and never opens IndexedDB/WASM SQLite.

- [ ] **Step 4: Implement crash-resumable proof metadata**

Store one canonical `app_metadata` row under key `b2-proof`:

```js
{
  schemaVersion: 1,
  phase: 'fresh' | 'background-test-ready' | 'ready-for-relaunch' | 'complete',
  commandIndex: 0,
  activeLearnerId: 'learner-a',
  expectedSessionId: null,
  learnerARevision: 0,
  learnerBDigest: '',
  preRelaunchDigest: '',
  migrationRollback: 'verified',
  atomicFailureCheckpoints: [],
  lifecycleEvents: [],
  updatedAt: 1_768_478_400_000,
}
```

On a genuinely fresh native database, first run V0-to-V1 with an injected failure after a deterministic schema statement, verify `user_version === 0` and no V1 table/data remains, then rerun the normal migration. After relaunch at revision 4, run the actual SQLite A3 repository once for each exact failure checkpoint using command index `4`, the progress-changing second correct Smart answer, proving learner A's canonical digest is unchanged after every rollback; then run the same command successfully once. Persist these results in proof metadata, so each native report proves native migration and progress-transaction rollback rather than inheriting Node-only evidence.

Update metadata in the same database but never inside the A3 repository transaction. Persist phase only after the associated command is committed. Before every command and after relaunch, compare the validated A3 revision/session/result against the exact precondition and postcondition for `commandIndex`: if the postcondition already exists, advance metadata without replaying the command; if the precondition exists, execute once; if neither matches, fail closed. Derive the next command solely from this reconciled durable phase plus validated A3 snapshot; do not trust DOM/session memory.

- [ ] **Step 5: Render diagnostic evidence, not product UI**

Keep the B1 dark diagnostic theme and add visible labels for database name, schema, learner isolation, lifecycle and active proof phase. Required accessible text at completion:

```text
KS2 Spelling
B2 persistence proof
SQLite schema: 1
Learner isolation: verified
Lifecycle: pause, resume and relaunch verified
B2 proof complete
```

Do not migrate Monster art, final theme, production navigation, Parent UI or commerce copy in this task.

- [ ] **Step 6: Run controller, shell and full Node gates**

Run:

```bash
node --test tests/b2-proof-controller.test.mjs tests/app-shell.test.mjs
npm test
npm run lint
npm run build
npm run native:sync:check
git diff --check
```

Expected: all PASS; built files include the native plugins but no server URL, remote runtime or web SQLite initialisation.

- [ ] **Step 7: Commit the deterministic B2 shell**

```bash
git add src tests/b2-proof-controller.test.mjs tests/app-shell.test.mjs
git commit -m "feat: add B2 persistence proof shell"
```

### Task 11: Define the shared native evidence and device-ownership contract

**Files:**

- Create: `scripts/lib/b2-evidence.mjs`
- Create: `scripts/fingerprint-b2-application.mjs`
- Create: `tests/b2-evidence-contract.test.mjs`
- Create: `tests/b2-device-ownership-contract.test.mjs`
- Create: `tests/b2-application-fingerprint.test.mjs`

**Interfaces:**

- Consumes: B1 virtual-device ownership/cleanup helpers and B2 proof metadata.
- Produces: strict report validation, cross-platform logical comparison, the application fingerprint consumed by both native wrappers and reusable ownership-safe helpers; no device is booted in this task.

- [ ] **Step 1: Write failing evidence and ownership contract tests**

Define `B2_NATIVE_REPORT_SCHEMA_VERSION === 1`. Both reports must include:

```js
{
  schemaVersion: 1,
  platform: 'ios-simulator' | 'android-emulator',
  testedApplicationCommit: '<40 lowercase hex>',
  applicationFingerprint: '<64 lowercase hex>',
  identity: { applicationId: 'uk.eugnel.ks2spelling' },
  device: { name: '', runtime: '', osVersion: '' },
  nativeVersions: {},
  pluginVersions: {
    capacitorCore: '8.4.1',
    capacitorApp: '8.1.0',
    capacitorSqlite: '8.1.0',
  },
  database: {
    name: 'ks2-spelling',
    physicalFile: 'ks2-spellingSQLite.db',
    schemaVersion: 1,
    foreignKeys: 1,
    journalMode: 'wal',
    synchronous: 2,
    busyTimeout: 5000,
    integrityCheck: 'ok',
    databaseSha256: '',
    walModeObserved: true,
    sidecarsObserved: [],
    everyObservedSidecarCollectedSafely: true,
  },
  lifecycle: {
    events: ['pause', 'resume'],
    preKillPid: '',
    postRelaunchPid: '',
    differentPid: true,
  },
  proof: {
    resumedSessionId: '',
    preKillRevision: 4,
    finalRevision: 6,
    finalLogicalSnapshotSha256: '',
    atomicFailureCheckpoints: [
      'after-subject-state', 'after-practice-session', 'after-events',
      'after-monster-state', 'after-camp-state', 'after-revision', 'before-commit',
    ],
    migrationRollback: 'verified',
    learnerBIsolation: 'verified',
    learnerBInitialSha256: '',
    learnerBFinalSha256: '',
    monsterState: 'spelling-derived-child-owned',
    starterCampRows: 0,
  },
  privacy: {
    serverUrl: null,
    packagedAndroidPermissions: [],
    androidBackupEnabled: false,
    addedIosUsageDescriptionKeys: [],
    addedIosEntitlements: [],
  },
  ui: {
    diagnosticPhase: 'complete',
    machineStateSource: 'durable-proof-metadata' | 'uiautomator-hierarchy',
    screenshotSha256: '',
    manualVisualInspection: 'passed',
  },
  cleanup: { deviceStopped: true },
}
```

The validator must reject unknown keys, mismatched platform-only fields, equal PIDs, revisions other than exact `4` then `6`, missing/duplicate/reordered lifecycle events, unequal learner-B digests, missing failure checkpoints, non-empty Starter Camp, any permission, enabled Android backup, any server URL, missing screenshot bytes, missing manual visual inspection or stale commit/fingerprint.

The B2 fingerprint must include every runtime source, certified vendor file, package/lock/config, native project input, schema, generated Capacitor packaging input and native proof script that can change application behaviour. It must exclude `.git`, `node_modules`, `.native-build`, `.superpowers/sdd`, screenshots and generated reports. The contract test must fail if a required native/proof input is omitted or an evidence output is included.

- [ ] **Step 2: Run evidence/ownership contract tests and record RED**

Run:

```bash
node --test tests/b2-evidence-contract.test.mjs tests/b2-device-ownership-contract.test.mjs tests/b2-application-fingerprint.test.mjs
```

Expected: FAIL because the shared evidence/ownership contract does not exist.

- [ ] **Step 3: Extend B1 device ownership without weakening it**

Reuse the exact B1 iOS device `KS2 Spelling iPhone 17` on iOS `26.5` and Android AVD `KS2_Spelling_API_36`/API `36`/port `5580`. Preserve collision checks, process-group ownership, fresh install, screenshot colour/text population checks and `finally` shutdown. Shared helpers must not mutate devices or B1 evidence.

- [ ] **Step 4: Run and commit the shared evidence contract**

```bash
node --test tests/b2-evidence-contract.test.mjs tests/b2-device-ownership-contract.test.mjs tests/b2-application-fingerprint.test.mjs
npm run lint
git diff --check
git add scripts/lib/b2-evidence.mjs scripts/fingerprint-b2-application.mjs tests/b2-evidence-contract.test.mjs tests/b2-device-ownership-contract.test.mjs tests/b2-application-fingerprint.test.mjs
git commit -m "test: define B2 native evidence contract"
```

### Task 12: Implement the iOS lifecycle and relaunch proof wrapper

**Files:**

- Create: `scripts/prove-b2-ios.mjs`
- Create: `tests/b2-ios-wrapper-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 11 evidence/ownership helpers and the Simulator's live WAL database.
- Produces: deterministic `npm run prove:b2:ios`; final evidence capture waits until Task 13's complete proof-tooling checkpoint.

- [ ] **Step 1: Write the failing iOS wrapper test**

Require exact build/install identity, host-side read-only phase polling, revision/session/digest checks, PID change, screenshot-before-termination ordering, safe database+sidecar collection and owned-simulator shutdown.

- [ ] **Step 2: Run the test and record RED**

```bash
node --test tests/b2-ios-wrapper-contract.test.mjs
```

Expected: FAIL because the iOS wrapper does not exist.

- [ ] **Step 3: Implement the iOS lifecycle/relaunch proof**

The iOS wrapper must:

1. sync/build unsigned, boot the exact simulator, uninstall any prior app, install and launch;
2. resolve the Simulator data container, open the live database through a separate host-side read-only SQLite connection that honours WAL, poll canonical `app_metadata['b2-proof']` until `phase === 'background-test-ready'`, and record the app PID;
3. foreground a bundled system application to generate pause, then relaunch KS2 Spelling to generate resume;
4. poll the same host-side read-only SQLite view until `phase === 'ready-for-relaunch'`, then require revision `4`, the exact active session ID, pre-relaunch digest and unchanged learner-B digest;
5. `simctl terminate` the exact bundle, prove the prior PID is absent, relaunch and require a different PID;
6. poll the same durable proof metadata until `phase === 'complete'`;
7. while KS2 Spelling is still foreground and running, capture the screenshot and record exact-text state as machine-verified from durable metadata, not OCR; the controller's text remains a manual visual-inspection requirement;
8. only after screenshot capture, terminate the app and copy the data container's `Library/CapacitorDatabase/ks2-spellingSQLite.db`, `-wal` and `-shm` as one evidence set;
9. open the collected copy read-only with Node SQLite and collect PRAGMAs/integrity/logical snapshot evidence;
10. shut down only the owned simulator in `finally`.

Do not use iCloud/platform backup or production signing.

- [ ] **Step 4: Add the command and commit the iOS wrapper**

Add `"prove:b2:ios": "node scripts/prove-b2-ios.mjs"`, then run:

```bash
node --test tests/b2-ios-wrapper-contract.test.mjs tests/b2-evidence-contract.test.mjs
npm run lint
git diff --check
git add package.json scripts/prove-b2-ios.mjs tests/b2-ios-wrapper-contract.test.mjs
git commit -m "test: add iOS B2 proof wrapper"
```

### Task 13: Implement Android proof and capture matched cross-platform evidence

**Files:**

- Create: `scripts/prove-b2-android.mjs`
- Create: `tests/b2-android-wrapper-contract.test.mjs`
- Create: `reports/b2/ios-simulator-proof.json`
- Create: `reports/b2/android-emulator-proof.json`
- Create: `reports/b2/ios-simulator-proof.png`
- Create: `reports/b2/android-emulator-proof.png`
- Modify: `package.json`

**Interfaces:**

- Consumes: Tasks 11–12 and exact Android B1 ownership helpers.
- Produces: `npm run prove:b2:android` plus matched iOS/Android reports at one clean proof-tooling checkpoint.

- [ ] **Step 1: Write the failing Android wrapper test**

Require hierarchy phase readiness, `KEYCODE_HOME` pause/resume, PID change, UI-before-force-stop ordering, `run-as` database+sidecar collection, empty permissions and owned-emulator shutdown.

- [ ] **Step 2: Run the test and record RED**

```bash
node --test tests/b2-android-wrapper-contract.test.mjs
```

Expected: FAIL because the Android wrapper does not exist.

- [ ] **Step 3: Implement the Android lifecycle/relaunch proof**

The Android wrapper must:

1. sync/build debug, boot the exact owned AVD, uninstall any prior app, install and launch;
2. wait for `Background test ready` through the existing `uiautomator` hierarchy mechanism and record `pidof uk.eugnel.ks2spelling`;
3. send `KEYCODE_HOME` for pause, restart the exact activity for resume;
4. wait for `Ready for relaunch`;
5. `am force-stop` the package, prove the PID is absent, relaunch and require a different PID;
6. wait for `B2 proof complete`, then while the app remains foreground collect UI hierarchy and screenshot evidence;
7. only after UI capture, force-stop before using `run-as uk.eugnel.ks2spelling` to copy `databases/ks2-spellingSQLite.db`, `-wal` and `-shm` to an app-readable temporary directory, pull all present sidecars, then remove only those temporary copies;
8. collect read-only SQLite evidence and the exact empty `aapt2 dump permissions` result;
9. stop only the owned emulator/process group in `finally`.

Never root the emulator or change application debuggability outside the debug build.

- [ ] **Step 4: Commit the final clean native-proof tooling checkpoint**

Add `"prove:b2:android": "node scripts/prove-b2-android.mjs"`. Each script clears only its own platform report/screenshot plus `reports/b2/b2-exit-report.json`; it preserves plugin/dependency audits and the other platform report. Both calculate the B2 application fingerprint before build and reject application changes outside the tested checkpoint.

```bash
node --test tests/b2-android-wrapper-contract.test.mjs tests/b2-ios-wrapper-contract.test.mjs tests/b2-evidence-contract.test.mjs
npm run lint
git diff --check
git add package.json scripts/prove-b2-android.mjs tests/b2-android-wrapper-contract.test.mjs
git commit -m "test: prepare cross-platform B2 proof"
git status --short
```

- [ ] **Step 5: Run the iOS virtual proof and inspect the screenshot**

```bash
npm run prove:b2:ios
```

Expected: PASS with different pre/post PIDs, exact session resume, schema/PRAGMA/integrity evidence, all failure checkpoints, learner isolation, zero Starter Camp and visible full diagnostic shell. Visually inspect `reports/b2/ios-simulator-proof.png`; blank/partial/permission-dialog screenshots fail.

- [ ] **Step 6: Run the Android virtual proof and inspect the screenshot**

```bash
npm run prove:b2:android
```

Expected: the same logical-state digest as iOS, zero packaged permissions and a visible complete diagnostic shell. Visually inspect `reports/b2/android-emulator-proof.png`; blank/partial/system-dialog screenshots fail.

- [ ] **Step 7: Compare and commit evidence only**

```bash
node --test tests/b2-evidence-contract.test.mjs tests/b2-ios-wrapper-contract.test.mjs tests/b2-android-wrapper-contract.test.mjs
git diff --check
git add reports/b2/ios-simulator-proof.json reports/b2/android-emulator-proof.json reports/b2/ios-simulator-proof.png reports/b2/android-emulator-proof.png
git commit -m "test: certify B2 native persistence proof"
```

### Task 14: Add the exit builder, CI contract and final application checkpoint

**Files:**

- Create: `scripts/build-b2-exit-report.mjs`
- Create: `tests/b2-exit-report-builder.test.mjs`
- Create: `tests/b2-exit-report.live.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ci-workflow-contract.test.mjs`
- Modify: `package.json`
- Modify: `docs/architecture/b1-authority.md`
- Create: `docs/architecture/b2-persistence-authority.md`
- Modify: `docs/operations/native-development.md`
- Modify: `docs/compliance/sdk-privacy-register.md`
- Modify: `README.md`
- Modify: `reports/b2/native-plugin-build.json`
- Modify: `reports/b2/native-plugin-audit.json`
- Modify: `reports/b2/dependency-audit.json`
- Modify: `THIRD_PARTY_NOTICES.md`

**Interfaces:**

- Consumes: final application checkpoint, iOS/Android proof reports, dependency audit, plugin audit and frozen B1 entry evidence.
- Produces: `npm run verify:b2`, strict exit-report generation/checking, hosted unsigned build coverage, documentation and one clean final application checkpoint. The deterministic native build, dependency and plugin audit authorities plus third-party notices are regenerated after application changes and committed in this checkpoint. This task does not regenerate or commit the iOS/Android lifecycle reports, their screenshots or `b2-exit-report.json`.

- [ ] **Step 1: Write failing exit-builder and CI contract tests**

Re-run Task 11's fingerprint contract unchanged. The exit-builder test uses complete temporary fixtures and must cover valid generation plus stale commit/fingerprint, missing inputs, mismatched logical digests, permission/backup drift and lifecycle-proof failures. `tests/b2-exit-report.live.mjs` is a fail-closed explicit harness for the committed report, but its non-`.test.mjs` name deliberately keeps it outside the default `npm test` glob until Task 15 has recaptured evidence. Task 14 commits that harness as part of the clean application/verifier checkpoint; it must not be added or changed after native capture.

The exit report must bind:

- B1 commit/tree/run URL and both frozen B1 evidence hashes;
- B2 tested application checkpoint commit and application fingerprint;
- exact SHA-256 of `reports/b2/native-plugin-build.json`, `reports/b2/native-plugin-audit.json` and `reports/b2/dependency-audit.json`, plus every package/SPM/Maven report hash they bind;
- both native report hashes and screenshot hashes;
- equal iOS/Android canonical logical snapshot digest;
- exact database/schema/PRAGMAs;
- all seven atomic checkpoints;
- migration rollback, process PID change, session resume and learner-B isolation;
- zero Starter Camp rows, child-owned spelling-derived Monster state;
- `server.url === null`, zero Android permissions, zero new iOS usage keys/entitlements, merged Android `allowBackup=false`, and packaged legacy/cloud/device-transfer all-domain exclusion results;
- SQLCipher packaged, no-encryption mode and unresolved export classification;
- visual status `diagnostic-proof-only` and explicit visual/theme/asset migration deferral;
- all B2 non-goals as false claims.

- [ ] **Step 2: Run focused closing tests and record RED**

Run:

```bash
node --test tests/b2-application-fingerprint.test.mjs tests/b2-exit-report-builder.test.mjs tests/ci-workflow-contract.test.mjs
```

Expected: FAIL because the exit builder and B2 CI contract do not exist.

- [ ] **Step 3: Implement the strict exit-report builder**

`build-b2-exit-report.mjs --write` writes only after every input validates and both platform logical digests match. `--check` regenerates in memory and compares byte-for-byte. No report may refer to `HEAD` implicitly; tested application commit is the clean application checkpoint before evidence-only commits.

Add:

```json
"verify:b2": "npm run verify:vendor && npm run test:upstream:a3 && npm test && npm run lint && npm run build && npm run audit:dependencies && npm run native:sync:check && npm run test:ios && npm run test:android && npm run test:android-resolved-policy && node scripts/build-b2-exit-report.mjs --check"
```

- [ ] **Step 4: Extend hosted CI without claiming virtual-device proof**

Retain three jobs and full-history checkout. Domain/Web must run the Node SQLite contract/parity/atomicity/lifecycle suites using Node `24.18.0` without fresh Android resolution. iOS must sync and compile the exact SwiftPM plugins unsigned. Android must install exact API/Build Tools 36, sync, run unit tests, compile debug plus unsigned release, certify the resolved dependency closure, run the dedicated two-test resolved-Android policy file, prove empty packaged permissions and check committed B2 exit evidence. Hosted CI validates committed virtual proof; it does not claim to rerun simulator/emulator lifecycle evidence.

- [ ] **Step 5: Document the proven and deferred boundary**

`b2-persistence-authority.md` must identify the database/schema, exact adapter contract, lifecycle semantics, two-learner proof, native report paths and authority hashes. It must explicitly state:

- B2 proves transactional local persistence on virtual iOS/Android only;
- production profiles/security/backup remain C2;
- physical devices/accessibility/performance remain B4;
- SQLCipher export classification remains unresolved release work;
- current shell is diagnostic, not final visuals;
- a dedicated Visual / Theme / Asset Migration Spec follows Gate B `GO` and precedes C3 child UI.

- [ ] **Step 6: Commit the final clean B2 application checkpoint before recapture**

Regenerate the deterministic native build and dependency/plugin audit authorities after every application change, then run all focused/unit/build checks and commit every final application, native, config, verifier, CI, documentation and deterministic audit input before either native lifecycle proof is recaptured. Do not regenerate the iOS/Android proof reports or screenshots, and do not create `b2-exit-report.json` in this task:

```bash
npm ci
npm run verify:vendor
npm run test:upstream:a3
npm test
npm run lint
npm run build
npm run native:sync:check
npm run test:ios
npm run test:android
npm run test:android-resolved-policy
npm run report:b2-native-plugins
npm run audit:dependencies -- --write
actionlint .github/workflows/ci.yml
git diff --check
git add .github package.json package-lock.json capacitor.config.json docs scripts src tests config android ios README.md THIRD_PARTY_NOTICES.md reports/b2/native-plugin-build.json reports/b2/native-plugin-audit.json reports/b2/dependency-audit.json
git commit -m "test: prepare final B2 application checkpoint"
git status --short
```

Expected: the working tree is clean. This exact commit becomes `testedApplicationCommit`; its B2 fingerprint is calculated before evidence capture. No application/config/native/verifier input may change in the later evidence-only commit.

### Task 15: Regenerate and publish the final B2 evidence set

**Files:**

- Modify: `reports/b2/ios-simulator-proof.json`
- Modify: `reports/b2/android-emulator-proof.json`
- Modify: `reports/b2/ios-simulator-proof.png`
- Modify: `reports/b2/android-emulator-proof.png`
- Create: `reports/b2/b2-exit-report.json`

**Interfaces:**

- Consumes: Task 14's exact clean application checkpoint and all strict builders.
- Produces: one unbroken local gate, visually inspected matched native evidence, exit report and an evidence-only pushed commit.

- [ ] **Step 1: Write the live exit-evidence assertion and record RED**

`tests/b2-exit-report.live.mjs` invokes the builder's live `--check` path and fails closed when the report is absent, stale, references a dirty/non-checkpoint application state, or disagrees with either native report, screenshot, plugin audit, dependency audit, packaged backup/D2D evidence or fingerprint. Run the already-committed harness once before recapture and expect RED because Task 14 deliberately did not create final exit evidence.

```bash
node --test tests/b2-exit-report.live.mjs
```

- [ ] **Step 2: Run one unbroken local B2 gate and regenerate evidence**

```bash
npm ci
npm run native:doctor
npm run verify:vendor
npm run test:upstream:a3
node --test tests/sql-connection-contract.test.mjs tests/canonical-json.test.mjs tests/capacitor-sqlite-connection.test.mjs tests/sqlite-schema.test.mjs tests/sqlite-migration-rollback.test.mjs tests/database-command-gate.test.mjs tests/sqlite-spelling-snapshot-store.test.mjs tests/sqlite-command-repository.test.mjs tests/sqlite-adapter-parity.test.mjs tests/sqlite-atomicity.test.mjs tests/sqlite-multi-learner.test.mjs tests/app-lifecycle-contract.test.mjs tests/database-lifecycle-coordinator.test.mjs tests/b2-proof-controller.test.mjs
npm run lint
npm run build
npm run audit:dependencies
npm run native:sync:check
npm run test:ios
npm run test:android
npm run test:android-resolved-policy
npm run prove:b2:ios
# Expected exit 5 with b2_ios_manual_attestation_required. The root controller
# inspects the original-resolution PNG and creates only the screenshot-SHA-bound
# .native-build/b2/ios-manual-attestation.json described in the native runbook.
npm run prove:b2:ios -- --attest .native-build/b2/ios-manual-attestation.json
npm run prove:b2:android
# Expected exit 5 with b2_android_manual_attestation_required. The root controller
# inspects the original-resolution PNG and creates only the screenshot-SHA-bound
# .native-build/b2/android-manual-attestation.json described in the native runbook.
npm run prove:b2:android -- --attest .native-build/b2/android-manual-attestation.json
node scripts/build-b2-exit-report.mjs --write
npm test
node --test tests/b2-exit-report.live.mjs
actionlint .github/workflows/ci.yml
git diff --check
```

Expected: every ordinary command and both `--attest` finalisation commands PASS. Each initial capture exits `5` only for its exact manual-attestation-required code. The root controller inspects both screenshots at original resolution before authoring the SHA-bound attestations. Attestations contain no private data, and no pending proof, generated report, screenshot or audit JSON is hand-edited. The working tree contains only the two lifecycle reports, two screenshots and exit report intended for the evidence commit; all three deterministic Task 14 audit authorities remain byte-for-byte frozen.

- [ ] **Step 3: Commit only regenerated evidence, then push**

```bash
git status --short
git add reports/b2/ios-simulator-proof.json reports/b2/ios-simulator-proof.png reports/b2/android-emulator-proof.json reports/b2/android-emulator-proof.png reports/b2/b2-exit-report.json
git commit -m "test: close B2 persistence evidence"
git push -u origin jamesto/mobile-b2-persistence
```

Expected: the evidence report references the immediately preceding clean application checkpoint, while branch `HEAD` is the evidence-only commit. If any application input appears in `git status` after proof capture, stop, commit that fix as a new application checkpoint, recapture both platforms and rebuild the exit report.

### Task 16: Complete independent review, fast-forward main and prove exact main

**Files:** No planned source files. Review fixes follow the new application-checkpoint/evidence-recapture sequence from Tasks 14–15.

**Interfaces:**

- Consumes: Task 15 branch head, hosted CI and whole-branch review package.
- Produces: reviewed B2 fast-forwarded to `main`, exact-main hosted CI and authority values for B3.

- [ ] **Step 1: Require exact-head hosted CI and broad independent review**

Watch the branch run and require all three jobs successful at the exact pushed head. Generate a whole-branch review package from `git merge-base main HEAD` through the final head. The independent reviewer must evaluate every B2 exit criterion, scope/non-goals, SQL transaction correctness, lifecycle failure safety, native evidence, dependency/privacy honesty and code quality. Resolve every Critical/Important finding through one fix wave. Any review fix to application/config/native/verifier inputs requires a new clean application checkpoint, both native proofs recaptured, a new evidence-only commit, push and new exact-head green run.

- [ ] **Step 2: Fast-forward B2 into mobile main and re-prove exact main**

Only after clean broad review and exact-head branch CI:

```bash
git switch main
git pull --ff-only origin main
git merge --ff-only jamesto/mobile-b2-persistence
git push origin main
```

Require the exact merged main SHA to complete all three hosted jobs successfully. Record the final main commit/tree, B2 exit-report SHA-256, dependency-audit SHA-256 and run URL in the next B3 plan authority block. Do not delete the branch until those values are recorded.

## B2 exit criteria

B2 is complete only when all items below have direct evidence:

1. B1 entry commit/tree/reports/run are frozen exactly and the nine A3 producer tests run byte-for-byte against the vendored runtime.
2. `@capacitor-community/sqlite@8.1.0` and `@capacitor/app@8.1.0` pass npm/SPM/Maven, licence, privacy and both-native-build audits with exact pins.
3. `server.url` remains null; web SQLite is refused; no endpoint, account, download, filesystem or commerce runtime exists.
4. Android packaged permissions are exactly empty after explicit biometric removals; Android backup/device transfer is disabled with merged-manifest and all-domain exclusion evidence until C2; iOS adds no usage-description key or entitlement.
5. SQLite database `ks2-spelling`, physical file `ks2-spellingSQLite.db`, schema `1`, foreign keys, WAL, FULL synchronous mode, 5000 ms busy timeout and integrity check are proven on both platforms.
6. Migration V0→V1 is deterministic/idempotent; unknown newer schema fails closed; injected migration failure rolls back schema/data and never deletes/resets the database.
7. SQLite implements the exact A3 `{ runCommandTransaction }` surface and matches memory-adapter plans/logical snapshots for the deterministic Starter scenario.
8. All seven A3 failure checkpoints, invalid plans, planner failure, conflict retry/exhaustion and no-change plans preserve all-or-nothing durable state and transient-effect rules.
9. Two learners exist and learner A's entire round, lifecycle and relaunch do not change learner B's canonical digest.
10. Monster state is child-owned/spelling-derived; Starter Camp is empty/inaccessible; no Parent projection is stored in Monster/Camp state.
11. Pause/resume is idempotent, new commands stop during pause, the owned transaction drains, WAL checkpoint/close is best-effort, and correctness survives a kill before callback completion.
12. Both virtual platforms show a different PID after termination/relaunch, recover the exact active session without replaying a committed command, complete the round and reach the same final logical-state digest.
13. Both screenshots show the full `B2 persistence proof` diagnostic shell; current visuals are explicitly not final product/theme/asset work.
14. SQLCipher packaging and unresolved export classification are recorded honestly; B2 makes no encryption-at-rest or store-compliance completion claim.
15. One unbroken local gate, exact-head three-job branch CI, clean broad review, fast-forward main and exact-head three-job main CI all pass.

## Complete B2 verification command

```bash
npm ci
npm run native:doctor
npm run verify:vendor
npm run test:upstream:a3
node --test \
  tests/sql-connection-contract.test.mjs \
  tests/canonical-json.test.mjs \
  tests/capacitor-sqlite-connection.test.mjs \
  tests/sqlite-schema.test.mjs \
  tests/sqlite-migration-rollback.test.mjs \
  tests/database-command-gate.test.mjs \
  tests/sqlite-spelling-snapshot-store.test.mjs \
  tests/sqlite-command-repository.test.mjs \
  tests/sqlite-adapter-parity.test.mjs \
  tests/sqlite-atomicity.test.mjs \
  tests/sqlite-multi-learner.test.mjs \
  tests/app-lifecycle-contract.test.mjs \
  tests/database-lifecycle-coordinator.test.mjs \
  tests/b2-proof-controller.test.mjs
npm test
npm run lint
npm run build
npm run audit:dependencies
npm run native:sync:check
npm run test:ios
npm run test:android
npm run test:android-resolved-policy
npm run prove:b2:ios
npm run prove:b2:android
node scripts/build-b2-exit-report.mjs --check
node --test tests/b2-exit-report.live.mjs
actionlint .github/workflows/ci.yml
git diff --check
git status --short
```

## Explicit B2 non-goals and next-plan boundary

B2 does not implement or prove production child/Parent/profile UI, Parent PIN or biometrics, reset/delete, platform backup or `backup.sqlite`, retention/20 MB recovery, billing/IAP, entitlements, pack download/activation, production audio, Full KS2/Guardian/Boss/Pattern Quest/Camp UI, Hero systems, final theme/assets, physical devices, accessibility/performance, store signing or release compliance.

After exact-main B2 closes, write the detailed **B3 Sandbox Billing and Signed Download Proof** plan from the recorded B2 commit/tree/report hashes and then execute it task-by-task. After B3, write/execute B4. Only a B4 `GO` authorises C-series work. A dedicated **Visual / Theme / Asset Migration** plan must be written after Gate B `GO` and completed before C3 child-facing production UI; it covers existing Spelling and Monster assets, reward presentation, typography, colour tokens, motion, phone/tablet layouts and side-by-side visual QA.

## Primary dependency references checked for this plan

- Capacitor App v8 API: `https://capacitorjs.com/docs/apis/app`
- Capacitor community SQLite npm package/version and SQLCipher warning: `https://www.npmjs.com/package/@capacitor-community/sqlite`
- SQLite plugin source/tag `v8.1.0`: `https://github.com/capacitor-community/sqlite/tree/v8.1.0`
- SQLite plugin SwiftPM manifest: `https://raw.githubusercontent.com/capacitor-community/sqlite/v8.1.0/Package.swift`
- SQLite plugin Android dependency manifest: `https://raw.githubusercontent.com/capacitor-community/sqlite/v8.1.0/android/build.gradle`
- Node SQLite API: `https://nodejs.org/docs/latest-v24.x/api/sqlite.html`
