# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `kmorey/herdr-plugins`.
Use the `gh` CLI with `--repo kmorey/herdr-plugins`.

## Conventions

- Publish a spec or ticket by creating a GitHub issue. For multiline
  content, use `gh issue create --title "..." --body-file <file>`.
- Read tickets with `gh issue view <number> --comments`; include
  their labels when evaluating triage state.
- List issues with `gh issue list`, filtering by state and label.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."`
  or `gh issue edit <number> --remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.
- Use the role mapping in `docs/agents/triage-labels.md`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and pull requests share a number space. When a reference
is ambiguous, determine its type before acting.
