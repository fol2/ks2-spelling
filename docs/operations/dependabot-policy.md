---
module: operations
tags:
  - dependabot
  - dependencies
  - native
problem_type: operating-policy
---

# Dependabot policy for frozen and native surfaces

This is the durable maintainer contract for dependency discovery in this
repository. `.github/dependabot.yml` is the machine configuration. Bot pull
requests are not merge candidates whenever a reviewed identity is frozen.

## Purpose

Keep update pressure. Do not auto-merge frozen surfaces. Convert each relevant
bot proposal into a focused human change from a green current `main`.

An open `ci-nightly-red` issue means the scheduled B4 gate is red right now.
Do not start Action SHA re-attestation or a native/Gradle/Capacitor migration
from that red baseline. Issue #74 remains open until the complete next
Dependabot cycle has been observed to behave as designed: weekly GitHub
Actions and npm discovery, monthly Gradle with `open-pull-requests-limit: 1`,
Capacitor npm proposals receiving `native-dependency-review` through the
tracked workflow, and no `groups`, `ignore` or auto-merge. A single
post-merge `opened`, `reopened` or `synchronize` event is only the bounded
Capacitor label-workflow transition evidence. That event alone cannot close
issue #74. A green configuration-only pull request does not close that issue.

## What bot pull requests are

Dependabot edits are discovery inputs. They report that a newer version exists.
They are not the change that lands.

Do not reopen or reuse stale Dependabot branches. Future work starts from the
then-current green `main`. Do not comment `@dependabot merge`. Repository
auto-merge stays off for these surfaces.

## Labels

Every Dependabot proposal carries `dependencies` and `manual-review`.

Gradle version-update proposals receive `native-dependency-review` from
`.github/dependabot.yml` when Dependabot opens them.

npm-hosted Capacitor packages cannot receive that label from Dependabot
config: labels are per ecosystem, not per package, and a second npm entry
for the same directory is not a supported way to split labels.
`.github/workflows/dependabot-native-labels.yml` is the smallest in-repo
compensation. After that workflow is on `main`, a `dependabot[bot]` pull
request whose title names `@capacitor/` or `@capacitor-community/` receives
`native-dependency-review` on `opened`, `reopened` or `synchronize`. GitHub
evaluates the actor and title in the job `if`. The shell then runs only a
constant `gh pr edit --add-label native-dependency-review` command. The title
never reaches the shell. The workflow does not create labels, and it does not
merge or close pull requests.

Existing Capacitor npm proposals that were already open when the workflow
landed, and that receive no later `opened`, `reopened` or `synchronize` event,
keep the labels they already have. That is the live exception until a
qualifying event or the next Dependabot cycle recreates them. Do not backfill
the label onto those pull requests.

Referenced labels are `dependencies`, `manual-review` and
`native-dependency-review`. Confirm they exist with a read-only
`gh label list` at change time; the ordinary test suite does not call GitHub.

`github-actions` proposals are not native dependency changes and must not
receive `native-dependency-review`.

## GitHub Actions re-attestation

GitHub Actions stay on a weekly, reviewable discovery cadence. Exact Action
SHA pins are frozen identities. A bot pull request that bumps `uses:` is a
discovery input, not a merge candidate.

Convert each proposal into a focused human pull request from a green current
`main`, one workflow identity at a time. `actions/checkout` and
`actions/setup-node` must not be re-attested in parallel when they share
workflow and contract surfaces.

The human change updates the pinned SHA, the adjacent version comment, and
every contract test that locks that identity, then proves the exact workflow
still does the same job. Do not describe a raw Dependabot SHA edit as
re-attestation.

## Android, Gradle and Capacitor re-attestation

Android and Gradle proposals are monthly with `open-pull-requests-limit: 1`.
That is the version-update native queue. Security updates are not bound by
that limit; they remain discovery inputs and still need the same human gate.

Never combine Gradle wrapper, Android Gradle Plugin, UIAutomator or Google
Services changes in one migration pull request. Do not add Dependabot `groups`
that would fold those migrations together.

After each native dependency change:

1. regenerate the exact applicable Gradle lockfiles and
   `android/gradle/verification-metadata.xml`;
2. regenerate dependency-policy inventories, native plugin reports, third-party
   notices and other generated evidence the change actually invalidates;
3. review `docs/compliance/sdk-privacy-register.md`, packaged-permission
   evidence, licence terms and store-disclosure assumptions; and
4. pass the full merge-tier Android gate, not only the fast pull-request lane.

Capacitor npm packages follow this native path even though they live in the npm
ecosystem. A version bump of `@capacitor/android`, `@capacitor/ios`,
`@capacitor/core`, `@capacitor/cli` or `@capacitor-community/*` is not a routine
JavaScript patch.

## Compatibility failures

A red bot pull request caused by an actual source or compile incompatibility
is a real incompatibility. Do not describe it as merely "red by design".

The UIAutomator 2.3.0 → 2.4.0 proposal failed to compile at the Android B4
instrumentation seam. Reintroduction requires source or API adaptation, lock
and resolved-evidence regeneration, and device or instrumentation validation.

## Google Services

`com.google.gms:google-services` is on the Android `buildscript` classpath and
is not applied as a plugin. The next proposal must first decide whether that
optional plugin is used at all: remove it if unused, otherwise perform a full
evidenced upgrade. That decision is not made by merging a bot version bump.

## No dependency is ignored forever

Do not add `ignore` entries to `.github/dependabot.yml`. Do not comment
`@dependabot ignore this dependency`, `@dependabot ignore this major version`
or `@dependabot ignore this minor version`. Closing a bot pull request without
those commands preserves discovery. A rejected version is revisited later from
green `main`, not silenced.

## Future execution order

Once the scheduled baseline is green, execute these as separate human changes,
each returning the repository to a green full baseline before the next begins:

1. `actions/checkout` v7 manual re-attestation;
2. `actions/setup-node` v7 manual re-attestation;
3. decide remove-versus-upgrade for Google Services;
4. UIAutomator migration with source adaptation and device or instrumentation
   validation; and
5. Gradle wrapper / Android Gradle Plugin / JDK toolchain migration.
