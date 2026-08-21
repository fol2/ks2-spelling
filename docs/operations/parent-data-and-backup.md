---
module: parent-data
tags:
  - retention
  - privacy
problem_type: operating-policy
---

# Parent data and retention

## Local retention

KS2 Spelling has no analytics or remote learner-profile store. Learner
profiles, spelling snapshots, practice sessions, progress, Monster state and
Camp state remain in the local SQLite database until a Parent changes them.

- **Reset learning** permanently removes one learner's spelling state and
  recreates an empty spelling snapshot. The learner profile and current
  selection remain.
- **Delete learner** permanently removes that profile and all learner-owned
  spelling rows through the database relationship. Another learner's bytes do
  not change.
- Both operations require an unlocked Parent session and exact nickname
  confirmation.
- The app has no recycle bin or silent retention period.

The Parent security verifier and app-wide commerce or installed-pack authority
are not learner-owned and are therefore not removed by a learner reset or
deletion.

v1 does not export or import a learning file. Cross-device learning on Apple
devices is the iCloud learning replica.

## iCloud learning replica

Local SQLite remains the source of truth. On iOS, learner profiles and learner
snapshots are also replicated to the family's CloudKit private database
(`iCloud.uk.eugnel.ks2spelling`) through an app-owned plugin. Selected learner,
Parent PIN, store entitlements and pack-install stay device-local.

Apply is gated on this device's store entitlement. A never-entitled device that
receives a Full snapshot stays on Starter and parks the Full history under
`preserved-full-learning-v1:{learnerId}`. Conflicts merge progress, guardian,
monster and camp per item; prefs and an in-flight practice session are
last-writer-wins. No iCloud account means local-only, with no child-facing
sign-in nag. Android stays local-only with a no-op port.

### Owner two-device acceptance — open gate

Physical proof is owner-gated and unrecorded. Source composition of the
private-CloudKit replica is not that proof. The executable signed-RC
checklist, evidence-record fields and lane distinctions live in
[`docs/operations/2026-08-21-icloud-learning-replica-physical-acceptance-runbook.md`](./2026-08-21-icloud-learning-replica-physical-acceptance-runbook.md).
Do not treat an unsigned Simulator compile, portal container configuration,
or the privacy markdown as a pass.

## Device storage policy

The database deliberately uses SQLite `no-encryption`; packaged SQLCipher is
not evidence of application-level encryption. The product instead enforces the
following policy before opening local data and verifies it again after initial
migration:

- iOS applies Complete file protection to the fixed database directory and its
  existing contents, rejects symbolic links and excludes the directory from
  automatic backup;
- Android keeps automatic cloud backup and device transfer disabled, excludes
  every data domain in both backup-rule formats and verifies an app-private
  database directory.

The installed-pack root is also excluded from iOS backup. If the database
policy cannot be verified, product bootstrap fails without transforming or
replacing existing database bytes. Final physical-device behaviour and store
disclosures remain part of the deferred release proof.

The iOS Simulator does not expose the protection attribute synchronously to the
app process after Complete protection is requested. The host later reports
Complete Until First User Authentication, but development builds record the
in-process result as unobservable rather than promoting that host observation
to an app guarantee. The physical build continues to require Complete
protection and the final iPhone proof must verify it.
