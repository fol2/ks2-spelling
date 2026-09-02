# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product identity

### Product display name

The name shown on the App Store listing and the Home Screen: Spelling Camp.
`ks2-spelling` remains the code name and bundle identity
(`uk.eugnel.ks2spelling`).

## Package governance

### Package transition authority

The closed approval boundary that permits only reviewed additions to package scripts and dependencies while requiring the rest of the package definition to remain identical to its frozen baseline.

## Spelling content and audio

### Spelling catalogue

A versioned spelling-content scope that contains its spelling items and binds their teaching, dictation, reward, access, and audio requirements for validation together.

### Vocabulary set

A selectable slice of a spelling catalogue's core content that a learner can
set off with: either the whole core set, or one school-year band within it.

Bands are subsets of the core set rather than separate content, so a spelling
counted in a band is also counted in the core. A set that would be empty for
the installed catalogue is never offered, so which sets a learner sees depends
on which catalogue is installed rather than on the learner.

### Set off

The learner's act of starting a round: choosing a vocabulary set and committing
to it, after which the chosen set is fixed for that round.

### Spelling item

The catalogue-owned unit that gives one target spelling its accepted forms, teaching metadata, sentence prompts, and stable runtime identity.

### Sentence prompt

A catalogue-owned example sentence attached to one spelling item and used as the source of its normal and slow dictation cues.

### Dictation

The process of speaking a spelling cue to the learner — the word alone, or the
word inside its sentence prompt — so that the spelling is heard rather than
shown.

Each cue has a normal and a slow rendering. Because dictation never presents the
target spelling as text, the learner must be able to hear a cue and write their
answer in the same moment.

The word also names the surface built around that constraint — the layout that
must hold a cue, an answer field and a software keyboard at once. Where a
sentence speaks of a dictation layout rather than a dictation cue, this second
sense is meant.

### Keyboard ownership

Which element the operating system regards as the origin of the software
keyboard.

The rule this project settled on is that ownership belongs to the real, visible
answer field and to nothing else: no hidden input, no plugin, no bridge
controller, and no code that hides, disables or moves the field while the
keyboard is up. Focus is reclaimed only inside the gesture that asked for it.
The rule exists because a competing owner does not produce an error — it
produces a focused field with a caret and no keys, which reads as a platform
fault rather than an application one.

### Spelling audio authority

The reviewed contract that fixes which word and sentence sources, playback profiles, encodings, validation rules, and runtime-generation boundaries are valid for a spelling catalogue.

Its authoring form may retain reproducibility metadata, while its runtime form excludes authoring-only details and permits playback only from installed, verified assets; a word source is replaced as one complete set rather than mixed incrementally.

### Playback profile

An approved bundled voice identity that binds the word and sentence sources, provenance labels, and audio variants used together when playing spelling cues.

### Complete audio matrix

The exhaustive set containing one natural word recording per playback profile plus normal and slow dictation recordings for every sentence prompt and playback profile in a spelling catalogue.

## Learner state

### Starter complete moment

The one child-facing celebration that fires when either Starter year band's
items become secure. The threshold is the Starter catalogue's own count for
that band, read from the existing monster/reward-track projection rather than
from a parallel counter. The remaining-word figure is Full core minus Starter
core. The presented flag is app-side state outside the learner snapshot, so
restart, reset, snapshot apply and replica apply cannot show it again. The
transaction stays behind the Parent gate.

### Companion roster

Camp Companions (Codex) lists every reward track the published spelling
catalogue owns. The Starter trial therefore shows the legendary aggregate
alongside Inklet and Glimmerbug even though that track is absent from the
Starter pack JSON. Hatch still follows each track's published thresholds, so
stage 1 of the legendary line stays unreachable on the Starter 20. The trial
egg is pinned to branch b1 in the product projection. The first command that
A3 persists companion state writes that same branch so the art cannot flip.

### Learner snapshot

The complete saved state of one learner's progress through a spelling
catalogue, owned and validated by the spelling engine rather than by the app.

It is stored and restored as a single unit under an exact-key contract, so the
app may not add fields to it; app-side state that needs persisting lives
outside the snapshot.

### iCloud learning replica

The CloudKit private-database copy of learner profiles and learner snapshots
on the family's Apple account, applied with per-item merge.

Selected learner, Parent PIN, store entitlements and pack-install stay
device-local. On apply, catalogue and entitlement are derived from this
device's store entitlement so a replica cannot raise the word list past what
this device has purchased.

### Post-commit epilogue

Work that follows a committed transaction. An auxiliary or self-healing step
swallows its failure; a required follow-up re-throws an error stamped
`postCommit: true` so the UI reports "done, but refresh failed" rather than
"failed".

### Parent progress summary

The derived view of every learner's progress presented to a parent.

It owns no data and is recomputed from saved learning on demand, so a failure
to produce it never means saved learning changed — and no operation that has
already committed may be reported as failed because the summary could not be
rebuilt.

### Parent PIN credential

The exact four-field projection of a stored parent security record that the PIN
verifier will accept — the algorithm, the iteration count, the salt and the
verifier.

The stored record is deliberately a superset: it also carries lock state,
failure counts and timestamps that the verifier must never see. The contract
rejects anything but the exact four keys rather than ignoring the extras, so
passing the whole record is not a tolerated shortcut but a hard failure, and it
surfaces as a validator error rather than as a wrong-PIN result.

## Packs and hosting

### Pack-object authority

The reviewed record of the exact private-R2 objects for one release channel:
each object's key, byte count, SHA-256, single-part ETag and custom metadata.

Sandbox keeps a single-pack document for the B3 proof pack. Production keeps
one multi-pack document covering the fifteen Full-KS2 shard packs in the live
production bucket. The document is bucket evidence, not a signature proof and
not a substitute for the downloadable-pack registry.

## Native packaging

### Application composition

The complete product or proof experience selected for a build, including its runtime behaviour and bundled content; it is distinct from native application identity because different compositions may use the same wrapper and bundle identifier.

### Release channel

The product world a build is compiled for, which decides whose packs the
running app will trust.

A build carries exactly one channel, fixed when it is compiled rather than
chosen at runtime, and the web bundle and the native layer each assert it
independently so the two halves of an installation cannot disagree about which
world's content is trustworthy. Channel is orthogonal to application
composition: the composition says which experience is packaged, the channel
says whose content that experience will accept. Proof and development
compositions have no channel — only a product build has one.

### Geometry floor

The narrowest and shortest viewport the product must survive: 320pt, from
iPad Slide Over. The Info.plist carries no `UIRequiresFullScreen`, so iPad
multitasking is mandatory.

### Performance floor

The oldest silicon the product declares: iPhone SE (2nd generation) (A13)
and iPad (8th generation) (A12), with `IPHONEOS_DEPLOYMENT_TARGET = 26.0`.

### Aesthetics judge

The current-device panel used to decide whether the product looks right. It
is not the performance-floor machine.

### Native build identity

The complete evidence tuple identifying what will be installed: source revision, application composition, native project and scheme, configuration, destination, bundle identifier, and packaged-content checks.

The tuple describes an artefact built here, and travels only as far as the
artefact's own bytes. A store that accepts an upload may assign its own build
number, so the number a distributed build carries is a label the store owns
rather than a property of the archive: it cannot stand in for any element of the
tuple, and a device faithfully reporting that number may be reporting it about a
different archive. Re-establishing identity after distribution therefore takes
evidence the store cannot rewrite — pairing the upload event against when the
archive was written, or probing the distributed bytes for content only the
intended build contains.

## Verification instruments

### Design harness

The development-only surface that renders the real product screens over an
in-memory stand-in for saved learning, so any screen and any visual state can
be reached in a browser at any viewport.

It is not a test and has no failing state; its only failure mode is to
photograph a screen the product never renders. That happens whenever the
stand-in publishes a different shape from the real projection — an omitted
field removes whatever that field draws and leaves a plausible screen behind —
so the harness's value as evidence rests entirely on the stand-in matching the
real contract.
