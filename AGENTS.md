# AGENTS.md

## Communication

- Address the user as James.
- Communicate with James in Hong Kong Cantonese.
- Keep key technical terms bilingual where helpful.
- Use UK English for code comments, documentation, commit messages and product
  copy.

## Engineering standards

- Keep changes SOLID, DRY and YAGNI.
- Prefer existing repository patterns over new abstractions.
- Treat remote synchronisation, learner state, spelling content, native
  projects, billing, downloads, signing and store release as
  production-sensitive.
- Preserve the local-first architecture and the no-remote-code boundary.
  Production builds must not use `server.url`, live reload, remote HTML or
  remote JavaScript.
- Do not claim SQLite, commerce, downloads, production readiness or production
  native plugins until their later approval and verification gates are closed.

## Credentials and external mutations

- Never request or accept a secret through a hidden terminal prompt.
- Do not access the login keychain, certificates, provisioning profiles,
  signing keys or store credentials. If credential input becomes necessary,
  stop at a visible, user-controlled gate.
- Do not create or mutate a remote repository, signing identity, store record,
  deployment or release without James's explicit authority.
- Do not accept SDK or store licence terms on James's behalf.

## Verification

- Base native verification claims on fresh command output and retain the exact
  target, configuration and device evidence.
- Distinguish an iOS Simulator from a physical iOS device, an Android Emulator
  from a physical Android device, and an unsigned or local-debug build from a
  signed release build.
- Treat project configuration, successful compilation, successful launch,
  signing readiness and store readiness as separate gates.
- Do not describe a native capability or production gate as complete when the
  evidence proves only a narrower state.

## Repository boundaries

- This repository must build and test without a sibling `ks2-mastery` checkout.
- Imported upstream source must be copied from its frozen Git authority with
  hash evidence; do not use symlinks, workspace links or an unpublished shared
  package.
- Keep generated outputs, local machine settings and secrets out of version
  control.
