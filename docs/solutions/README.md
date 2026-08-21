# Documented solutions

Solutions to problems this project has already solved, one file per learning,
organised by category. Each file carries YAML frontmatter (`module`, `tags`,
`problem_type` and the rest) so the store can be searched by field rather than
only by prose.

Two kinds of record live here. **Bug-track** docs record a defect that was
diagnosed and fixed: problem, symptoms, what did not work, the fix, why it
works, prevention. **Knowledge-track** docs record a practice or a rule:
context, guidance, why it matters, when it applies, examples. The
`problem_type` field decides which.

## Frontmatter conventions in this repository

The schema these docs follow ships with the `ce-compound` tooling, and its
`component` enum is shaped for a Rails application — `rails_model`,
`service_object`, `hotwire_turbo`, `payments`. This project is React, Vite and
Capacitor, so for some records the stock enum has no honest value.

**This repository extends the `component` enum rather than picking a value that
would be misleading.** The ratified extensions are:

| Value | Used by | Why the stock enum does not fit |
|---|---|---|
| `ios_text_input` | `integration-issues/dictation-software-keyboard-ios27-incident.md` | The nearest stock value is `frontend_stimulus`, which names a framework this project does not use and says nothing about native text input |
| `database_adapter` | `integration-issues/capacitor-sqlite-value-less-dml-executes-as-a-no-op.md` | `database` cannot distinguish the platform adapter from the store and schema layers, and the adapter is precisely what the record is about |
| `controller` | `logic-errors/test-doubles-that-accept-more-than-the-contract.md` | The record concerns two app-side controller modules; `service_object` blurs the layer |
| `ios_webview` | `integration-issues/capacitor-uncommitted-webview-reload-paints-black.md` | The nearest stock value is `frontend_stimulus`; this record is the native WKWebView host, not a JavaScript controller |

Two rules follow from that decision:

- The extension applies to `component` only. Inside `docs/solutions/`,
  `problem_type`, `root_cause`, `resolution_type` and `severity` use the stock
  enum values, because for those fields the stock set has been able to say what
  each record means. A `problem_type` outside the enum is worse than
  inconvenient — the schema reads that field to decide whether a doc is
  bug-track or knowledge-track, so an invented value leaves a record on neither
  track. This stock-enum rule is scoped to `docs/solutions/` only.
  `docs/operations/` already carries `operating-procedure` and
  `operating-policy`, and `docs/records/` now adds `freeze-record`.
- A new extension is a deliberate choice, not a default. Reach for it only when
  every stock value would misdescribe the record, and add a row above when you
  do.

Nothing in the repository validates this frontmatter today; these conventions
are kept by reading, not by a test.

## Adding to the store

`ce-compound` writes a new record; `ce-compound-refresh` reviews existing ones
against the current tree and repairs the drift. Both may be run by hand. Records
cite `file:line` freely, which means a large refactor can silently invalidate
them — that is what the refresh pass is for.
