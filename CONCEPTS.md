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

### Spelling audio authority

The reviewed contract that fixes which word and sentence sources, playback profiles, encodings, validation rules, and runtime-generation boundaries are valid for a spelling catalogue.

Its authoring form may retain reproducibility metadata, while its runtime form excludes authoring-only details and permits playback only from installed, verified assets; a word source is replaced as one complete set rather than mixed incrementally.

### Playback profile

An approved bundled voice identity that binds the word and sentence sources, provenance labels, and audio variants used together when playing spelling cues.

### Complete audio matrix

The exhaustive set containing one natural word recording per playback profile plus normal and slow dictation recordings for every sentence prompt and playback profile in a spelling catalogue.

## Native packaging

### Application composition

The complete product or proof experience selected for a build, including its runtime behaviour and bundled content; it is distinct from native application identity because different compositions may use the same wrapper and bundle identifier.

### Native build identity

The complete evidence tuple identifying what will be installed: source revision, application composition, native project and scheme, configuration, destination, bundle identifier, and packaged-content checks.
