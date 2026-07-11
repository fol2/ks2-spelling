# B2 SDK and privacy register

Review date: 11 July 2026

Owner: KS2 Spelling maintainer

This register describes the B2 local persistence proof. It is engineering evidence for later store-disclosure work, not a final Apple App Privacy, US encryption export or Google Play Data Safety submission.

## B2 proof truth

| Area | B2 evidence |
|---|---|
| Child data collection or transmission | None |
| Analytics and advertising | None |
| Runtime network endpoints | None |
| Android packaged permissions | None |
| iOS usage-description keys or app entitlements added | None |
| Android backup and device transfer | Disabled; every legacy and current domain is excluded until C2 |
| SQLite mode | `no-encryption` |
| Store commerce | Not enabled |
| Approval | B2 proof only |

The application opens the local database without encryption. SQLCipher is nevertheless packaged by `@capacitor-community/sqlite` on the native platforms. That packaging does not prove encryption at rest, does not establish a database-key policy and does not answer store export questions. US encryption export classification remains unresolved before store release. `ITSAppUsesNonExemptEncryption` is deliberately absent rather than guessed in either direction.

The plugin's Web/IndexedDB/WASM fallback is not initialised. Some web-fallback npm dependencies remain in the installed lock closure and notices, but B2 adds no runtime endpoint, download, account, analytics or cloud sync path.

## Conditionally approved B2 native plugins

| Package | Version | Source | B2 role | Approval boundary |
|---|---:|---|---|---|
| `@capacitor-community/sqlite` | 8.1.0 | Official capacitor-community SQLite repository | Local native SQLite bridge | B2 proof only; SQLCipher/export and production security remain release work |
| `@capacitor/app` | 8.1.0 | Official Ionic Capacitor plugins repository | Native lifecycle notifications | B2 proof only |

Both packages are exactly pinned in `package-lock.json`, including npm integrity. Their source, licence, privacy role, packaged status and restricted/export classification are recorded for every resolved npm identity in `reports/b2/dependency-audit.json`.

## Resolved iOS SwiftPM graph

| Identity | Requirement | Revision | Source | Licence | Packaged/privacy role |
|---|---|---|---|---|---|
| `capacitor-swift-pm` | exact version 8.4.1 | `2231987d85b8b0b289320b1d0947b4ae8345cde4` | Official Ionic repository | MIT | Capacitor and Cordova frameworks; supplied privacy manifests |
| `sqlcipher.swift` | exact version 4.17.0 | `205df55271aa1ba512a9bfe3fd1813bc9ac52a19` | Official SQLCipher Swift repository | BSD-3-Clause | SQLCipher framework is packaged; B2 still uses no-encryption mode |
| `zipfoundation` | exact version 0.9.20 | `22787ffb59de99e5dc1fbfe80b19c97a904ad48d` | Official ZIPFoundation repository | MIT | Resolved native archive support; no data collection or transmission |

Resolution validation is kind-aware: these are semantic version plus revision pins. In particular, the audited Capacitor Swift package is version 8.4.1 plus its exact revision, not the SQLite plugin's upstream `8.0.0` branch requirement that Task 2 prepared before the native build.

## Resolved Android Maven graph

The B2 toolchain resolves 314 unique module-version nodes across 5,452 exact project, configuration and buildscript scope memberships. Sixty-one modules occur in the packaged app release runtime. The finite Gradle verification inventory of 427 components and 847 artefacts. It covers the selected Maven modules, their POM closure, Gradle metadata and task-created host build tools.

All five project lockfiles are hashed and audited: app, Capacitor Android, Capacitor App, Capacitor Community SQLite and the Cordova compatibility project. Task 3 checks these Task 2 inputs without write mode; it does not silently rewrite dependency locks or verification metadata.

The SQLite graph includes SQLCipher, Room, AndroidX security and biometric libraries. The app manifest explicitly removes the biometric and fingerprint permissions contributed by that graph, and the built APK contains no declared or requested permissions. SQLCipher's published Maven POM omits a licence name; the exact POM hash and its linked Community Edition BSD 3-Clause licence interpretation are recorded in `config/third-party-notices-overrides.json`.

Twenty-five non-standard or reciprocal licence expressions remain restricted to their exact build, internal-tooling or test-only components. None is promoted to `:app` `releaseRuntimeClasspath`. James's Android SDK acceptance covers local build tooling only and does not approve packaged redistribution.

## Native backup and privacy surfaces

The merged Android manifest proves `android:allowBackup="false"`, names both backup-rule resources and contains no packaged permission. The legacy rules exclude `root`, `file`, `database`, `sharedpref` and `external`; both cloud-backup and device-transfer sections also exclude all five legacy domains and the four device-protected domains. B2 keeps backup and device transfer disabled until the C2 security design.

The built iOS application adds no usage-description key and no app entitlement. Capacitor and Cordova retain their supplied framework privacy manifests. Parent PIN, biometrics, database-key management, production backup, store signing and final disclosure certification remain outside B2.

## Not approved candidates

| Capability | Candidate package | Status |
|---|---|---|
| Filesystem | `@capacitor/filesystem` | Not approved |
| Billing | `@revenuecat/purchases-capacitor` | Not approved |
| Biometric | `capacitor-native-biometric` | Not approved |
