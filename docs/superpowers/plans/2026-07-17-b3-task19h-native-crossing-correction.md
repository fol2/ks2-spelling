# B3 Task 19H Native-Crossing Recovery Correction

## Scope and authority

This correction supersedes only the Task 19 D3/D4 treatment of exact retained
`launching`, `reinstall-launching` and `stop-executing` commands, the Android
force-stop receipt ordering, the Android five-second hold and the D5 deletion
proof. All other B3 authorities remain unchanged.

Task 19 is still open. This correction performs no Cloudflare/R2/store/device,
signing, installation or evidence mutation. The three-review gate in the Task 19H
scope correction supersedes the earlier five-review gate. Gstack, Matt and
Ponytail must approve the same exact HEAD; an actionable P1/P2 correction inside
the frozen Task 19 boundary invalidates all earlier approvals.

## Exact invocation finalisation

`pinInvocation()` remains an opaque, exact authority. `finaliseInvocation()` may
return `not-applicable` for an exact current `launching`,
`reinstall-launching` or `stop-executing` source because the corresponding
operation owns the safe convergence path. It must not mutate that source.

This exception is exact-state-bound. A pin taken before another helper advances
to one of those native-crossing states is stale and remains `rejected`. Matching
only command hash or capture ID is insufficient; the full retained source record
must equal the pin.

## Ambiguous native launch

An exact retained `launching` or `reinstall-launching` command resumes only by
pulling the fixed observation path. It never calls `transport.launch()` again.

- A valid command-bound observation transitions the same command to `launched`,
  publishes it transactionally and consumes the command normally.
- Pulling is bounded by the existing closed attempt/deadline authority.
- If no valid observation appears, exactly one ordinary claim selects
  `restart-required` and the controller exits with
  `instructionCode: REINSTALL_EXACT_BUILD`.
- Recovery acknowledgement is then pinned to that exact retained command and the
  existing D4 recovery transactions archive the old capture and create a fresh
  capture ID at sequence 1. The uncertain capture cannot continue.

## Ambiguous force-stop

`stop-executing` means a helper owns or owned the native side-effect boundary but
no durable `host-stopped` receipt is yet authoritative. Process absence is not a
receipt.

A helper which newly wins `stop-intent -> stop-executing` may execute the native
force-stop. A reopened helper observing retained `stop-executing` must not replay
force-stop. It selects the closed `restart-required` gate unless a concurrent
`host-stopped` receipt already won. The reinstall recovery then archives the
uncertain capture and creates a fresh capture.

The new ordinary edge is:

```text
stop-executing -> restart-required
```

Its frozen ordinary-claim SHA-256 is:

```text
37d72adc59dedeb6d16310b7a7ba15ad6d18adf914bce16cefe3c8faba37271f
```

The resulting schema-v2 authority SHA-256 is:

```text
76121199637bf3a587910189149105f0a54efe2d61a205507ce6377e2895b857
```

D4 archive/recovery ownership is not broadened: it still begins only from a
durable `restart-required` command. The new edge is an ordinary fail-closed bridge
to that existing gate.

## Android receipt ordering

After successful `adb shell am force-stop`, the Android physical transport must
invoke and await the supplied `retainReceipt` callback before its `forceStop()`
promise resolves. The callback is the controller's exact SQLite
`stop-executing -> host-stopped` transition. The controller no longer writes a
later fallback receipt after transport settlement.

A callback failure rejects the transport promise. A crash before the callback
commits leaves `stop-executing`; a crash after it commits leaves `host-stopped`.
Neither branch infers state from process absence.

## Five-second hold

The unacknowledged-purchase hold is strictly:

```js
await wait(5_000);
await release();
```

A rejected or interrupted wait never releases. A successful wait releases once
after completion. A release failure propagates.

## D5 repository proof

The deletion gate uses a bounded scanner over closed production and test roots.
It excludes documentation, generated output, fixtures, dependencies and Git
metadata. It proves:

- no production or test import names one of the seven deleted modules;
- no obsolete authority symbol survives outside closed proof-only assertions;
- the store-backed controller has no filesystem working-state dependency;
- the obsolete device-smoke output has no writer or final-evidence reader; and
- production B3 final output literals remain under `reports/b3`.

A temporary otherwise-unloaded source fixture must demonstrate that the scanner
detects a stale deleted import, obsolete authority symbol and obsolete writer.
