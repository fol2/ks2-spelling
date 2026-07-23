---
module: parent-data
tags:
  - retention
  - backup
  - privacy
problem_type: operating-policy
---

# Parent data, retention and learning backup

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

## Explicit backup

Export creates one canonical JSON learning backup through the system share
sheet. The limit is 5 MiB and 20 learners. It includes:

- each validated learner profile;
- each validated spelling snapshot; and
- the selected learner identifier.

It excludes the Parent PIN verifier and lockout record, commerce and
entitlement state, download jobs, installed packs, credentials and arbitrary
files. The app writes only a short-lived, app-controlled native export file;
the Parent chooses its destination. A copy saved elsewhere is controlled by
the Parent and is not deleted by a later in-app reset or deletion.

Import requires an unlocked Parent session and the exact confirmation word
`REPLACE`. The native and application layers both enforce the 5 MiB bound. The
application recomputes SHA-256, requires canonical UTF-8 JSON, validates every
profile and spelling snapshot against the installed catalogue, then replaces
all learner data in one SQLite transaction. Parent security, commerce and
installed packs remain unchanged. Cancellation or any failure leaves existing
learner data intact.

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
