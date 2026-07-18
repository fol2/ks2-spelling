# Task 19H Scope Correction and Task 22 Deferral

## Decision

Task 19 ends at locally verified, fail-closed live-proof tooling. It does not build
or execute a production Cloudflare finalisation session.

The previous proposal for an authorised session façade and an exact-runtime private
workerd probe is deferred to Task 22. Task 22 may implement either only when its live
execution proves that the existing scoped deployment wrapper, exact Cloudflare
readback, gateway contract tests and device smoke projection are insufficient.

## Task 19 boundary

Task 19 must provide:

- the B3-only device observation and resumable SQLite capture path;
- redacted platform screenshots with a metadata-free committed PNG policy;
- the pinned Wrangler/OAuth/R2 deployment adapter behind the existing explicit
  scope, run-token and local-authority gates;
- pure Cloudflare evidence composition and verification exercised with injected
  test primitives;
- a production Cloudflare finaliser which fails before any reader, SQLite, OAuth,
  Worker or R2 work until Task 22 supplies an authorised live session;
- the complete local, native, gateway, privacy and dependency verification set.

Task 19 must not add a session factory, public/admin endpoint, host capability flow,
second Worker, Miniflare probe, new dependency or duplicate runtime certification.

## Task 22 ownership

Task 22 owns all live Cloudflare finalisation: scoped authorisation, remote
inspection, exact deployment/object readback, safe public HTTP probes, the physical
device capability/Range journey and final six-file evidence assembly.

Internal zero-body/upstream/R2 behaviour remains a code-level claim proved by the
gateway tests. Live Task 22 evidence may claim only externally observable results.
Exact deployed bytes come from official Cloudflare readback; capability and Range
truth comes from the redacted device projection. Do not add a second proof unless a
concrete Task 22 gap requires it.

## Minimal implementation

1. Add one production-seam RED test: calling `proveB3Cloudflare()` without injected
   primitives must fail before every supplied reader or external seam.
2. Remove its premature default primitive construction. Keep injected primitives
   for pure local contract tests.
3. Run the complete Task 19H non-mutating verification set.

## Final review gate

All three reviews inspect the same exact candidate HEAD:

1. **Gstack boundary review**: Task 19 stays inside this correction and the approved
   spelling-mobile design; Task 22 work is not pulled forward.
2. **Matt code review**: `ask-matt` routes to the two-axis Standards and Spec review.
3. **Ponytail review**: reject speculative generality, duplicate proof, shallow
   modules, unnecessary tests/files/dependencies and anything Task 22 can own later.

Only actionable P1/P2 findings inside the frozen Task 19 boundary block completion.
A fix creates a new candidate HEAD and all three reviews rerun. Style preferences,
new threat models and deferred Task 22 improvements do not reopen Task 19.
