# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo. The glossary already lives at `CONCEPTS.md` — this project's name for the domain vocabulary, equivalent to `CONTEXT.md` in the skill templates. Do not create a parallel `CONTEXT.md`. When `/domain-modeling` resolves a term, update `CONCEPTS.md`.

## Before exploring, read these

- **`CONCEPTS.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. This directory is created lazily with the first ADR; it is not present yet.

If `docs/adr/` does not exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates ADRs lazily when a decision actually gets resolved.

`docs/solutions/` is a separate store of past bug and workflow learnings, not the domain glossary. Read it when implementing or debugging in a documented area, as `AGENTS.md` already says.

## File structure

Single-context repo:

```
/
├── CONCEPTS.md
├── docs/adr/          ← created lazily with the first ADR
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONCEPTS.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
