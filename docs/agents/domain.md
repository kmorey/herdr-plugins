# Domain docs

## Layout and reading rules

This repository uses a single-context layout:

- Root `CONTEXT.md`: domain glossary and context.
- `docs/adr/`: architecture decision records.

Before exploring the codebase, read `CONTEXT.md` and ADRs relevant
to the work. If these documents do not exist, proceed silently.
Domain modeling creates them as terms and decisions are resolved.

## Vocabulary

Use the glossary's canonical terms in specs, issues, code, and tests.
If a needed concept is absent, reconsider the terminology or record
the gap for domain modeling.

## Decisions

Surface contradictions with existing ADRs explicitly, identifying
the ADR and explaining why its decision may need revisiting.
