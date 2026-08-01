# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Package governance

### Package transition authority

The closed approval boundary that permits only reviewed additions to package scripts and dependencies while requiring the rest of the package definition to remain identical to its frozen baseline.

## Spelling content and audio

### Spelling catalogue

A versioned spelling-content scope that contains its spelling items and binds their teaching, dictation, reward, access, and audio requirements for validation together.

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

### Spelling audio authority

The reviewed contract that fixes which word and sentence sources, playback profiles, encodings, validation rules, and runtime-generation boundaries are valid for a spelling catalogue.

Its authoring form may retain reproducibility metadata, while its runtime form excludes authoring-only details and permits playback only from installed, verified assets; a word source is replaced as one complete set rather than mixed incrementally.

### Playback profile

An approved bundled voice identity that binds the word and sentence sources, provenance labels, and audio variants used together when playing spelling cues.

### Complete audio matrix

The exhaustive set containing one natural word recording per playback profile plus normal and slow dictation recordings for every sentence prompt and playback profile in a spelling catalogue.

## Learner state and backup

### Learner snapshot

The complete saved state of one learner's progress through a spelling
catalogue, owned and validated by the spelling engine rather than by the app.

It is stored and restored as a single unit under an exact-key contract, so the
app may not add fields to it; app-side state that needs persisting lives
outside the snapshot.

### Learning backup

The transferable file carrying every local learner's profile and learner
snapshot together with which learner was selected.

Importing one replaces the entire local learner store rather than merging into
it, so a partial or selective restore is not expressible; the file's bytes are
checked against their recorded digest before any part of it is applied.

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

## Native packaging

### Application composition

The complete product or proof experience selected for a build, including its runtime behaviour and bundled content; it is distinct from native application identity because different compositions may use the same wrapper and bundle identifier.

### Native build identity

The complete evidence tuple identifying what will be installed: source revision, application composition, native project and scheme, configuration, destination, bundle identifier, and packaged-content checks.
