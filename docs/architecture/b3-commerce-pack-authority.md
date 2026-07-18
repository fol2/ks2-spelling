# B3 commerce and signed-pack authority

B3 proves only the `b3-sandbox-proof` pack through Apple sandbox and Google Play
test purchases, the dedicated test Cloudflare Worker and its private R2 bucket.
It does not prove production Full content or audio, production secrets or cloud
resources, public pricing, store approval or release readiness.

## Local application boundary

Spelling practice, installed pack reads, learner progress, revision, Camp and
child-owned Monster progress remain local. The installed application contains its
runtime code; Capacitor does not load remote HTML or JavaScript. Online access is
limited to purchase verification, entitlement refresh/restore/revocation and pack
download or redownload. A verified installed pack remains usable offline.

The Parent surface observes spelling progress for multiple local child profiles.
Monster is the child's motivational presentation around spelling and is not a
cloud-tracked Parent metric.

## Task 20 checkpoint

Task 20 creates one clean application commit and its B3 fingerprint. The checkpoint
binds application, gateway, native, dependency, configuration, proof-wrapper,
validator and builder inputs. Any later change to those inputs, or to the CI
workflow, invalidates the checkpoint and requires fresh Task 21 distributions and
Task 22 live capture.

CI accepts only two final-evidence topologies:

- `pending`: none of the six final paths exists now or in available Git history;
- `complete`: all six paths form the exact evidence-only successor of the Task 20
  checkpoint and strict regeneration is byte-identical.

The six paths are:

```text
reports/b3/cloudflare-sandbox-proof.json
reports/b3/ios-sandbox-proof.json
reports/b3/ios-sandbox-proof.png
reports/b3/android-sandbox-proof.json
reports/b3/android-sandbox-proof.png
reports/b3/b3-exit-report.json
```

One to five current paths fail. Deleting earlier evidence cannot restore pending
mode. Task 22 supplies and validates the first five files, then the exit builder
uses the existing create-only publisher for the sixth. Task 23 changes no files.

## Downstream authority

Task 21 produces and inspects signed iOS and Android distribution authority outside
Git from the exact Task 20 checkpoint. Successful unsigned compilation is not
signing or store authority.

Task 22 alone may perform explicitly authorised Cloudflare/R2, store-test and
physical-device actions. It binds exact remote readback and the two signed installed
applications to the same Task 20 commit and fingerprint. Learner identities, raw
store proofs, refresh handles, capability URLs and device account data are not
committed.

## Deferred claims

B4 retains broad device quality, accessibility, performance, production security,
backup/export, family sharing and release-compliance work. Production Parent/child
UI, pricing and content remain later product gates. A dedicated Visual / Theme /
Asset Migration Spec remains mandatory after Gate B `GO` and before C3 child UI.
