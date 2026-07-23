# Product performance measurement authority

Status: measurement authority only; no performance threshold is claimed.

## Why the B4 comparator is rejected

The earlier external journey timer combined application work with WebView
startup, JavaScript-to-native bridge scheduling, SQLite and filesystem work,
audio-device startup, simulator or emulator load, and harness polling. That
number cannot identify application latency and must not be used to pass or
fail the product.

## Owned spans

A future optimisation measurement may score only a correlated span whose
start and finish are emitted by the same release-candidate operation:

- pure spelling command planning and projection;
- application orchestration around one command;
- explicit SQLite transaction time;
- local asset verification and decoding; and
- React commit-to-ready state where the same runtime can observe both ends.

Bridge transport, operating-system scheduling, WebView paint, store UI,
filesystem cache state, audio hardware start and test-harness polling are
reported separately. They may describe end-to-end experience, but they are not
silently attributed to application code.

## Evidence rule

Every recorded sample must bind the candidate commit, build mode, platform,
device or virtual-device identity, operation identifier, monotonic clock,
warm/cold state and the exact span boundaries. Independent runs may not be
subtracted from one another. A journey without correlated owned boundaries is
`unscored`, not slow and not fast.

Optimisation and threshold selection are deferred. Task 22 may capture
physical end-to-end observations, but no threshold claim is permitted until an
owned span exists and repeated samples distinguish application time from
system, bridge and harness time.
