# C1 Starter 20 integration checkpoint — 2026-07-23

Status: development-GREEN at
`77c317ea1c56ec7a2937b5289104b9ca1093683d`.

## Evidence

- The focused entitlement-boundary RED reproduced three failures; the same
  native, coordinator and SQLite set then passed 32/32.
- The one milestone media scan passed 840 unique local M4A assets with complete
  hash, format, duration, level, silence and orphan evidence.
- The deterministic unsigned hand-off contains 841 data-only files,
  11,340,063 compressed bytes and a null entitlement bound only to `ks2-core`.
- The iOS inspector accepted all 841 files and rejected 53 hostile fixtures.
- The final candidate passed `test:fast` 977/977, the production web build,
  focused lint, an unsigned generic iOS Simulator Debug build and Android
  `assembleDebug`.
- Independent read-only verification passed after closing the false-free pack
  identity boundary.

## Remaining gates

Production signing and public-key installation, hosted CI, physical devices,
accessibility and acoustic listening remain deferred to the frozen
release-candidate proof. This checkpoint grants no release or store authority.

## Product integration amendment

The later product journey exposed that requiring the free Starter hand-off to
be installed through the signed download path left a first installation stuck
in `missing` before a production signing key existed. The exact same verified
840 audio assets are therefore bundled as installed application resources.
Each playback request is constrained to the Starter namespace and verifies the
compiled byte size and SHA-256 before exposing audio. The signed-pack hand-off
above remains valid historical and hostile-archive evidence for downloaded
content; it is no longer the first-run Starter delivery mechanism.
