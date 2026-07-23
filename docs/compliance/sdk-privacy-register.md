# SDK and privacy register

Review date: 23 July 2026

Owner: KS2 Spelling maintainer

This register describes the B2 local persistence proof and B3 compiled commerce
and signed-pack capability. It is engineering evidence for later
store-disclosure work, not a final Apple App Privacy, US encryption export or
Google Play Data Safety submission.

The machine authority is the cross-hashed set
`reports/b2/native-plugin-build.json`, `reports/b2/dependency-audit.json`,
`reports/b2/native-plugin-audit.json` and `reports/b2/b2-exit-report.json`. The
exit builder also binds the exact package lock, SwiftPM resolution, Gradle
verification metadata, five Android lockfiles, both native lifecycle reports
and both screenshots. A hosted check validates those committed bytes and must
not be described as a fresh virtual-device run.

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

The machine-audited physically bundled WebView npm packages are exactly `@capacitor-community/sqlite`, `@capacitor/app`, `@capacitor/core`, `react`, `react-dom`, `scheduler`. SQLite and App bridge JavaScript is bundled, but the Web SQLite fallback is not initialised and native-only use is enforced. The fallback dependency modules `jeep-sqlite`, `sql.js`, Stencil and localForage are absent from the WebView bundle. The complete lock closure remains in the notices conservatively; notice inclusion is not evidence that a package is physically included.

The npm artefacts for `@capacitor/android` and `@capacitor/ios` are native build-source inputs, not packaged npm artefacts. Their resulting SwiftPM and Maven outputs are recorded separately. Every one of the 189 npm lock identities has an explicit evidence-derived distribution, `packaged` value, role, platform, privacy role and export classification in the B2 dependency audit.

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

## Packaged iOS privacy manifests

The built `App.app` contains exactly four privacy manifests. The audit binds the packaged relative path, byte hash and canonical Required Reason API declarations, and rejects a missing, additional or changed manifest.

| Packaged path | SHA-256 | Required Reason API declarations |
|---|---|---|
| `Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy` | `1bac827f49b2b8a5358491b9698203bf191791a6f1ba3a3ace3b1285d52d2d17` | None |
| `Frameworks/Cordova.framework/PrivacyInfo.xcprivacy` | `5a9b8fc0cddb10201bb47cc2804b3f004c7251476622d25bfc4eb54ed46e1084` | None |
| `Frameworks/SQLCipher.framework/PrivacyInfo.xcprivacy` | `9362796ba800a7b4169834eff8bde990866f40114ff7baac002b8bae543e8dd1` | Disk Space `E174.1`; File Timestamp `C617.1`, `3B52.1` |
| `ZIPFoundation_ZIPFoundation.bundle/PrivacyInfo.xcprivacy` | `9a2f930cedb8d58309a581b9bf9bf3673685ec02ae2197d9f1c56828b718dffd` | File Timestamp `0A2A.1` |

All four declare tracking false with empty collected-data and tracking-domain arrays. Required Reason API declarations do not imply child-data collection or transmission, but they must remain accurate for Apple review.

## Resolved Android Maven graph

The B2 toolchain resolves 314 unique module-version nodes across 5,452 exact project, configuration and buildscript scope memberships. Sixty-one modules occur in the packaged app release runtime. The finite Gradle verification inventory of 427 components and 847 artefacts. It covers the selected Maven modules, their POM closure, Gradle metadata and task-created host build tools.

All five project lockfiles are hashed and audited: app, Capacitor Android, Capacitor App, Capacitor Community SQLite and the Cordova compatibility project. Task 3 checks these Task 2 inputs without write mode; it does not silently rewrite dependency locks or verification metadata.

The SQLite graph includes SQLCipher, Room, AndroidX security and biometric libraries. The app manifest explicitly removes the biometric and fingerprint permissions contributed by that graph, and the built APK contains no declared or requested permissions. SQLCipher's published Maven POM omits a licence name; the exact POM hash and its linked Community Edition BSD 3-Clause licence interpretation are recorded in `config/third-party-notices-overrides.json`.

Twenty-five non-standard or reciprocal licence expressions remain restricted to their exact build, internal-tooling or test-only components. None is promoted to `:app` `releaseRuntimeClasspath`. James's Android SDK acceptance covers local build tooling only and does not approve packaged redistribution.

## Native backup and privacy surfaces

The merged Android manifest proves `android:allowBackup="false"`, names both backup-rule resources and contains no packaged permission. The legacy rules exclude `root`, `file`, `database`, `sharedpref` and `external`; both cloud-backup and device-transfer sections also exclude all five legacy domains and the four device-protected domains. B2 keeps backup and device transfer disabled until the C2 security design.

The built iOS application adds no usage-description key and no app entitlement. Its four packaged privacy manifests are certified above. Parent PIN, biometrics, database-key management, production backup, store signing and final disclosure certification remain outside B2.

The B2 proof uses only virtual devices. Physical-device privacy, accessibility
and performance certification remain B4. The diagnostic proof shell is not the
final visual design; Visual / Theme / Asset Migration follows Gate B `GO`
before C3 child UI.

## B3 Play Billing transition

The app-owned Android commerce bridge adds the exact official
`com.android.billingclient:billing:9.1.0` Java artefact. The current locked B3
graph resolves 327 unique module-version nodes across 5,570 exact scope
memberships; 74 occur in the packaged release runtime. The finite Gradle verification inventory contains 442 components and 878 artefacts. B2 reports
above remain frozen and are not rewritten by this transition.

The merged B3 APK requests only the existing normal `INTERNET` permission plus
the normal `com.android.vending.BILLING` and `ACCESS_NETWORK_STATE` permissions
contributed by the official Play Billing runtime closure. It adds no dangerous
or runtime-granted permission, account identifier, analytics SDK or advertising
SDK. The bridge never acknowledges a purchase locally and never supplies an
obfuscated account or profile identifier. Final Google Play Data Safety wording
and the committed B3 dependency report remain Task 18 release evidence.

Task 18 binds this compiled capability in `reports/b3/native-build.json` and
`reports/b3/dependency-audit.json`. The native report hashes the simulator app
binary, both Android APK variants and the app-owned debug/release Commerce,
PackTransfer and ZIP-inspector classes. It also records executed rejection of
the exact 53-file hostile ZIP corpus on iOS and Android, the closed native
method surfaces, and the packaged Android permission surface. The packaged app
contains no Capacitor Filesystem dependency, RevenueCat SDK, Billing KTX,
app-owned Kotlin source or Kotlin Gradle plugin. StoreKit remains a system
framework and Play Billing remains the exact Java artefact above.

The resolved Play Billing 9.1.0 closure includes Google DataTransport, Firebase
encoder and Play services runtime modules declared by the official Billing POM.
The app does not configure an analytics or advertising product and does not
send a learner or spelling-progress payload to commerce, but this is not proof
that every vendor runtime module never collects or transmits data. Vendor
runtime data-practice assessment and final Play Data Safety review therefore
remain pending before store release.

The B3 commerce gateway receives store proof for verification, but no learner,
nickname, spelling-progress, monster or child-profile payload. The only durable
download authority in the app is an opaque sealed refresh handle; expiring
capability URLs are kept in memory and are not persisted. The app does not
configure an analytics or advertising product or SDK. These are compiled and
deterministic fake proof boundaries only: live store, live cloud,
physical-device and final store disclosure proof remain separate later gates.

Spelling practice, installed-pack use, learner progress and child-owned Monster
progress remain local and available offline. Network access is limited to
commerce verification, pack download and redownload, entitlement refresh,
restore and revocation. B3 sandbox and test proof must not be described as
production release readiness.

Task 19 physical-capture working and recovery state is retained only in the
ignored local SQLite schema-v2 database. Its final JSON and PNG files are
immutable derived evidence, not a second mutable state store. Task 19 performs
no live Cloudflare/R2, store or device mutation and makes no signed/live-evidence
claim.

## C2B Parent access transition

The active product source now includes one app-owned Parent access bridge. On
iOS it uses the system `LocalAuthentication` framework; on Android it uses the
exact locked `androidx.biometric:biometric:1.1.0` artefact already present in
the verified dependency inventory. No third-party Capacitor biometric plugin
has been added.

The active Android manifest declares the normal
`android.permission.USE_BIOMETRIC` permission and continues to remove the
legacy fingerprint permission. The iOS app declares only
`NSFaceIDUsageDescription` for this capability. Android automatic cloud backup
and device transfer remain disabled and excluded across every database and
file domain.

Parent access is local-only. A six-digit Parent PIN is represented by a random
salt and a PBKDF2-SHA-256 verifier; the PIN itself is not persisted. Biometrics
are an explicit opt-in from an already unlocked Parent session and never
replace initial PIN setup. The app locks the Parent session on pause. These
claims are compiled Simulator and local contract evidence only; physical
biometric behaviour remains deferred to the final device proof.

The frozen B2 reports and their historical statements above are not rewritten
by this C2B transition.

## Not approved candidates

| Capability | Candidate package | Status |
|---|---|---|
| Filesystem | `@capacitor/filesystem` | Not approved |
| Billing | `@revenuecat/purchases-capacitor` | Not approved |
| Biometric | `capacitor-native-biometric` | Not approved |
