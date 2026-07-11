# B1 SDK and privacy register

Review date: 11 July 2026

Owner: KS2 Spelling maintainer

This register describes the committed B1 local prototype. It is evidence for engineering and later store-disclosure work; it is not a final Apple App Privacy or Google Play Data Safety submission.

## B1 product truth

| Area | B1 evidence |
|---|---|
| Child data collection | None |
| Child data transmission | None |
| Analytics and advertising | None |
| Android app permissions | None |
| Store commerce | Not enabled |
| Runtime network endpoints | None |
| Local content | Certified bundled spelling runtime only |

The app code does not declare a Required Reason API or an app-authored privacy manifest. Capacitor and Cordova supply their framework privacy manifests. This statement must be reviewed again when native storage, downloads, commerce, biometrics, analytics or any remote service is introduced.

## Resolved npm production dependencies

| Package | Version | Role | Platform | Permissions | Data access | Runtime endpoints | Privacy and Data Safety impact |
|---|---:|---|---|---|---|---|---|
| `@capacitor/android` | 8.4.1 | Native platform source | Android | None | None | None | No app permission or collection declared |
| `@capacitor/core` | 8.4.1 | Bundled/native bridge runtime | All | None | None | None | No B1 data access |
| `@capacitor/ios` | 8.4.1 | Native platform source | iOS | None | None | None | Framework manifests supplied |
| `react` | 19.2.7 | Bundled runtime | WebView | None | None | None | No B1 data access |
| `react-dom` | 19.2.7 | Bundled runtime | WebView | None | None | None | No B1 data access |
| `scheduler` | 0.27.0 | Bundled transitive runtime | WebView | None | None | None | No B1 data access |
| `tslib` | 2.8.1 | Bundled transitive runtime | WebView/native bridge JavaScript | None | None | None | No B1 data access |

Direct build-only tools are `@capacitor/cli` 8.4.1, `@vitejs/plugin-react` 6.0.3, `oxlint` 1.71.0 and `vite` 8.1.4. They do not ship as application runtime SDKs. The generated dependency audit records their source, licence and ownership fields.

## Resolved iOS SwiftPM dependency

| Package | Version | Revision | Source | Licence | Privacy impact |
|---|---:|---|---|---|---|
| `capacitor-swift-pm` | 8.4.1 | `2231987d85b8b0b289320b1d0947b4ae8345cde4` | Official Ionic repository | MIT | Capacitor and Cordova framework manifests supplied |

## Resolved Android Maven graph

The Task 8 toolchain resolves 286 unique module-version nodes across 3,133 exact project, configuration and buildscript scope memberships. The actual test and assemble tasks add 12 exact host build-tool nodes. The committed certification records every selected POM source URL and SHA-256, selected and task-created binary artefact checksums, three project dependency lockfiles and the finite Gradle verification inventory of 391 components and 765 artefacts. Fifty modules are present in the packaged app release runtime.

Twenty-five non-standard or reciprocal licence expressions are restricted to the exact build, internal-tooling or test-only components recorded in `config/maven-licence-policy.json`. None appears in `:app` `releaseRuntimeClasspath`; the audit fails if one is promoted there. James personally accepted the Android SDK terms for local build tooling. That acceptance does not approve redistribution in the packaged app.

The complete evidence, raw POM declarations, inheritance source hashes, distribution scopes and source URLs are in `reports/b1/android-dependency-resolution.json`. `THIRD_PARTY_NOTICES.md` includes every resolved Maven module-version alongside npm and SwiftPM dependencies.

| Coordinate | Version | Scope |
|---|---:|---|
| `com.android.tools.build:gradle` | 8.13.0 | Build |
| `com.google.gms:google-services` | 4.4.4 | Resolved build classpath; not applied without `google-services.json` |
| `io.github.gradle-nexus:publish-plugin` | 1.3.0 | Registered inactive condition; absent because `CAP_PUBLISH` is not enabled |
| `androidx.activity:activity` | 1.11.0 | Runtime declaration |
| `androidx.appcompat:appcompat` | 1.7.1 | Runtime declaration |
| `androidx.coordinatorlayout:coordinatorlayout` | 1.3.0 | Runtime declaration |
| `androidx.core:core` | 1.17.0 | Runtime declaration |
| `androidx.core:core-splashscreen` | 1.2.0 | Runtime declaration |
| `androidx.fragment:fragment` | 1.8.9 | Runtime declaration |
| `androidx.webkit:webkit` | 1.14.0 | Runtime declaration |
| `org.apache.cordova:framework` | 14.0.1 | Runtime declaration |
| `junit:junit` | 4.13.2 | Test declaration |
| `androidx.test.ext:junit` | 1.3.0 | Instrumented test declaration |
| `androidx.test.espresso:espresso-core` | 3.7.0 | Instrumented test declaration |
| `org.json:json` | 20250517 | Test declaration |
| `org.mockito:mockito-core` | 5.20.0 | Test declaration |

The generated Google Services classpath is resolved as build tooling because it is declared, but B1 has no `google-services.json`, Google runtime SDK, analytics or push service. It is not an active or packaged runtime dependency.

## Not approved candidates

These entries are planning candidates only. They have not passed dependency, permission, privacy, licence, commerce or store-policy review and are not installed.

| Capability | Candidate package | Status |
|---|---|---|
| SQLite | `@capacitor-community/sqlite` | Not approved |
| Filesystem | `@capacitor/filesystem` | Not approved |
| Billing | `@revenuecat/purchases-capacitor` | Not approved |
| Biometric | `capacitor-native-biometric` | Not approved |
| Lifecycle | `@capacitor/app` | Not approved |
