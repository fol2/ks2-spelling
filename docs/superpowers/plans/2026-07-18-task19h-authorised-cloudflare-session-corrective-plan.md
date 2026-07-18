# Task 19H Authorised Cloudflare Session Corrective Plan

## Status and authority

This corrective plan supersedes point fixes for the two Cloudflare P2 findings on
Task 19H candidate `2522c67248294b07dfeabe5e64222702b0bb3c5a`. The Task 19 amendment and
the exact six-file evidence topology remain authoritative.

No step may deploy, upload, inspect a live account, contact a store, sign a build,
install an application or operate a physical device while implementing or testing
this plan.

## Problem

The current production finaliser constructs Cloudflare primitives directly. It can
therefore begin authenticated readback without first validating the approved scope,
run token and durable local authority. The deployment wrapper owns those gates, but
the finaliser does not. This is an authority-boundary defect rather than a missing
conditional.

The default `smokeGateway` is also intentionally fail-closed. Tests inject a smoke
result, but the production finaliser has no honest implementation. Adding a host
capability or an administrative endpoint would violate the amendment: capability
and Range proof belongs to the physical application after it owns a legitimate
sealed handle.

## Deep-module design

Create one `B3AuthorisedCloudflareLiveSession` façade. It is the only production
route from either deployment or finalisation to OAuth, Worker or R2 primitives.

Opening a session must complete, in order:

1. validate `cloudflare-deploy` scope and the closed run-token shape;
2. validate the durable local mutation/run authority;
3. validate external prerequisites, including a stable reread of the run authority;
4. read the tracked account, Worker, origin, bucket and two-object authority;
5. bind the clean application commit and fingerprint;
6. only then construct the sterile OAuth child and exact-byte primitives.

The façade owns disposal and exposes operations, not raw child/process handles. A
failed gate must produce zero primitive construction, child spawn, remote inspection
or remote mutation. Deployment and finalisation inject the same session factory in
tests; they do not accept an unauthorised bag of production primitives.

## Split smoke authority

Keep the two independent proof domains explicit:

- Device smoke: the SQLite projection proves capability and Range behaviour using
  the application's legitimate sealed handle. No handle, capability URL or query
  leaves the device observation port.
- Host-safe smoke: after exact Worker content readback matches the deterministic
  local bundle, run those exact main-module and data-module bytes locally under the
  pinned workerd/Miniflare runtime. Instrument the rate-limit binding, request body,
  outbound service and R2 binding to prove CORS, every-route rate limiting,
  zero body/upstream/R2 work after rejection, and missing-binding fail-closed.

The host-safe runner must not make a network request. Its identity is the already
verified deployment version plus exact script authority; it must not invent a second
remote identity observation. It always disposes the local runtime in `finally`.

Cache, temporary output and workerd state are private optimisations under
`.native-build/b3/`. Exact readback bytes and SHA authority, not those files, decide
acceptance.

## RED

Add production-seam tests which prove:

1. `proveB3Cloudflare()` with missing/wrong scope, run token or local authority makes
   zero primitive/session/remote calls;
2. deployment and finalisation both receive their operations through the same
   authorised façade;
3. a clean default finalisation path reaches a real local workerd smoke instead of
   `live gateway smoke input authority is unavailable`;
4. the exact locally executed module bytes equal the bound dry-run and Cloudflare
   readback authority;
5. allowed native CORS succeeds and foreign CORS fails;
6. rate-limited and missing-binding requests record zero body, upstream and R2 work;
7. runtime error, timeout and every mismatch dispose the runtime and session;
8. no smoke input or output contains a handle, capability, query, token, learner,
   profile, progress, Monster, account or device identifier.

Record the failing production-seam tests before implementation.

## GREEN

1. Add the authorised session façade beside the Cloudflare policy modules.
2. Move the existing deployment gate sequence into the façade without weakening or
   duplicating it.
3. Route both `deploy-b3-sandbox-gateway.mjs` and `prove-b3-cloudflare.mjs` through
   the façade.
4. Add the bounded exact-module local smoke runner to the live adapter. Do not add a
   public Worker route or host capability flow.
5. Separate deployment-readback identity, local host-safe CORS/rate-limit proof and
   device capability/Range projection in the evidence composer, while retaining the
   existing public report schema and exact claims.
6. Delete the test which freezes default smoke unavailability. Retain explicit
   dependency injection only behind the authorised session seam.

## Verification and review reset

Run the focused Cloudflare, prerequisite, evidence, wrapper and privacy suites first,
then the complete Task 19H non-mutating gate. Re-run gateway tests, lint, Wrangler
dry-run, root/gateway audits, deterministic proof, native builds, compiled hostile
scanners and Android resolved-policy certification.

The known Xcode StoreKit failure remains external and fail-closed. No mock may make
it green.

Any implementation commit creates a new exact candidate SHA. All five Task 19H
reviews are invalidated and must approve the same replacement SHA. If review finds
another authority bypass or another fake/live split at this seam, stop and revise
this façade rather than adding a caller-specific exception.
