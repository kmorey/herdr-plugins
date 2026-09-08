# Evolve Visual Proof into File Preview

## Problem Statement

Agents produce reports, comparison data, text exports, and screenshots on the machine where they run. Their responses contain filesystem links, but those links do not provide a consistent way to read the files beside the conversation, especially when the agent is remote.

The existing Visual Proof plugin already opens agent-generated PNGs in a Herdr-managed pane. Reports and other text artifacts need the same workflow. Creating another plugin for those files would duplicate pane lifecycle, navigation, and common actions.

## Solution

Evolve Visual Proof into a single File Preview plugin. Open PNG, Markdown, JSON, and plain-text files beside the originating agent through an explicit pane-opening command. Allow an ordered collection of different file types in the same gallery, with a suitable preview for each file.

Preserve the existing image experience, add readable and searchable text previews, and retain shared close, copy-path, and open-externally actions. Existing visual-proof environment variables remain accepted during migration.

This delivery supplies the viewer that future Herdr link activation can open. Directory browsing follows separately.

## User Stories

1. As a user, I want to preview an agent-generated report beside its conversation, so that I can review the result without locating it manually.
2. As a user, I want Markdown rendered with recognizable headings, lists, emphasis, links, and code blocks, so that reports are easy to read.
3. As a user, I want to switch Markdown to source view, so that I can inspect its original contents.
4. As a user, I want JSON formatted with indentation, so that comparison data is readable.
5. As a user, I want invalid JSON to show a clear diagnostic and its source text, so that I can still inspect a malformed artifact.
6. As a user, I want plain-text exports displayed with their line structure preserved, so that I can review their contents.
7. As a user, I want to scroll long text documents, so that I can read beyond the initial viewport.
8. As a user, I want to search a text preview and move between matches, so that I can find relevant information quickly.
9. As a user, I want a clear no-match indication, so that I know when a search found nothing.
10. As a user, I want PNG screenshots to retain native Herdr graphics rendering, so that image quality is preserved.
11. As a user, I want the existing terminal image fallback when native graphics are unavailable, so that screenshots remain viewable.
12. As a user, I want to navigate an ordered gallery containing screenshots and reports, so that related outputs stay together.
13. As a user, I want to see the current file name, path, type, and gallery position, so that I know which artifact I am reviewing.
14. As a user, I want previews to fit and redraw when the pane changes size, so that the viewer remains usable in different layouts.
15. As a user, I want to copy the current file's absolute path, so that I can reference it elsewhere.
16. As a user, I want to request that the current file open externally, so that I can use another application when available.
17. As a user, I want external-opening failures reported accurately, so that the viewer does not claim an unsuccessful action worked.
18. As a user, I want visible keyboard controls and a reliable close action, so that I can operate the viewer without guessing.
19. As a user, I want actionable errors for missing, unreadable, unsupported, or oversized files, so that I understand why a preview is unavailable.
20. As an agent, I want to supply one absolute path or an ordered JSON array of paths, so that I can explicitly deliver artifacts without scraping conversation output.
21. As an existing integration maintainer, I want legacy visual-proof path variables accepted during migration, so that callers can migrate incrementally.
22. As a visual-proof skill user, I want screenshot delivery to use the generic viewer, so that collecting visual evidence retains its existing purpose and workflow.
23. As a remote user, I want previews to read files on the agent's host, so that a server path is not mistaken for a file on my client machine.
24. As an integration maintainer, I want documented installation and invocation changes, so that I can move from the old plugin identity to the new one predictably.

## Implementation Decisions

- Evolve the existing plugin rather than maintain separate image and document plugins. Rename its directory, package identity, manifest identity, user-facing title, and documentation to File Preview, using the plugin ID `kmorey.file-preview` and package name `@kmorey/herdr-file-preview`.
- Retain the `viewer` pane entrypoint and split-pane opening pattern targeting the originating agent pane. Continue to require Node.js 20 or newer and preserve the existing supported platforms and Herdr minimum version unless implementation demonstrates a necessary change.
- Keep shared pane lifecycle, gallery navigation, metadata, resizing, and common actions in one viewer. Dispatch file content to internal PNG, Markdown, JSON, or plain-text rendering. No public renderer-extension API is required.
- Introduce `FILE_PREVIEW_PATH` and `FILE_PREVIEW_PATHS`. The plural variable contains a JSON array of absolute file paths. Accept `VISUAL_PROOF_PATH` and `VISUAL_PROOF_PATHS` as compatibility inputs during migration, and preserve positional path input.
- Resolve inputs deterministically: prefer new plural input, then new singular input, then legacy plural input, then legacy singular input, then positional arguments. Reject an invalid selected input rather than silently falling back. Document this precedence.
- Preserve supplied gallery order, duplicate removal, the existing maximum of 24 requested files, and wraparound navigation. Allow different supported file types in the same gallery.
- Support the existing PNG formats and 10 MiB image limit. Retain native pane graphics and the true-color Unicode half-block fallback. Switching from an image to text must clear the prior graphics placement.
- Identify PNGs through their signature and treat Markdown and JSON according to their conventional extensions. Other readable text files use the plain-text viewer; unsupported binary input produces a useful error. Directories receive a clear unsupported-target message in this delivery.
- Render common Markdown structure in the terminal and provide a source-view toggle. Link text and destinations remain readable; activating links is not required.
- Pretty-print valid JSON without silently changing numeric values or other data. If parsing fails, display the original text with a diagnostic rather than making the file inaccessible.
- Provide vertical scrolling, literal text search, next/previous match navigation, and a no-match state for text previews. Search operates on the currently selected rendered or source representation. Keep search input distinct from normal shortcut handling.
- Keep existing gallery and shared-action keys where possible. Display discoverable text controls and ensure resizing preserves a valid reading position and usable header/footer.
- Continue copying absolute paths using the existing terminal clipboard mechanism. External opening uses the platform opener on the viewer's host; it does not imply remote download or opening on the client machine. Report launch failures without terminating the viewer or claiming success prematurely.
- File paths are resolved on the host running the plugin pane. The caller is responsible for opening that pane alongside the intended agent on the appropriate host.
- Extend `--inspect` with file-type and relevant metadata for all supported file types. Retain image dimensions for PNGs and document any output-schema changes; inspection must not require an interactive terminal or graphics connection.
- Keep loading bounded. Retain existing image constraints and document an explicit text-size limit with actionable over-limit errors. The precise text limit is an implementation choice rather than an agreed product constraint.
- Update repository installation and invocation guidance. Accepting legacy environment variables does not alias the old Herdr plugin ID: document the relink/reinstall and caller changes required by the identity rename.
- Update the canonical visual-proof skill integration to invoke File Preview when available, retaining its screenshot-evidence purpose, Herdr environment checks, and ordinary Markdown links for other clients. Locate its owning repository before changing it; it is not present in this repository.

## Testing Decisions

- The user approved the viewer's public entrypoint as the primary testing seam. Tests should launch the viewer with real temporary files and documented inputs, then assert observable output and behavior rather than internal renderer structure.
- Extend `--inspect` coverage to file-type selection, relevant metadata, mixed galleries, input precedence, legacy variables, positional inputs, and useful validation errors. Inspection alone is not evidence that interactive previews work.
- Exercise terminal input/output for gallery navigation between PNG and text, scrolling, search and no-match behavior, Markdown source switching, resizing, and closing. Include terminal cleanup and removal of stale image graphics when switching types.
- Check representative Markdown, valid JSON including precision-sensitive numbers, malformed JSON, plain text, supported PNGs, missing/unreadable paths, binary files, directories, malformed path lists, and documented size limits through the highest applicable seam.
- Assert shared actions through their observable effects: clipboard output and platform-opener invocation, including a failed launch. Avoid launching real desktop applications in automated tests.
- Retain existing PNG decoder, fallback rendering, gallery, and mock Herdr graphics-socket regression coverage. The current Node built-in test runner, real temporary PNG fixtures, and fake Unix socket server provide prior art.
- Prefer a small number of representative terminal assertions over broad snapshots of every styling escape sequence. Introduce a terminal harness only where needed to exercise public interactive behavior.
- Run the plugin's test command after the rename and additions. Capture current visual evidence in Herdr for Markdown, JSON, and a mixed PNG/text gallery, including both native graphics and fallback behavior where available.

## Out of Scope

- Directory browsing and opening entries from a directory listing.
- Detecting or activating filesystem links in Herdr conversation output.
- Persistent artifact registration, an artifacts picker, or conversation-output scraping.
- Remote download, file transfer, client-side editor integration, and client-side desktop opening.
- Editing files in the preview pane.
- Additional image formats, PDFs, HTML/browser rendering, and executable content.
- A public plugin API for third-party renderers.
- Changing the purpose of the visual-proof skill or replacing its evidence-collection workflow.

## Further Notes

- Scope and the primary testing boundary were confirmed by the user. This spec covers the first delivery: plugin rename plus PNG, Markdown, JSON, and plain-text previews. Directory browsing is a follow-up.
- A successful result lets an agent explicitly open its report and comparison data alongside screenshots in a single pane. Existing conversation links will not automatically become clickable as a result of this work.
- No repository domain glossary or ADRs were found during exploration.
- Published as [GitHub issue #1](https://github.com/kmorey/herdr-plugins/issues/1) with the `ready-for-agent` triage label. The GitHub issue is the authoritative work item.
