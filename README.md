# Herdr plugins

Personal workflow plugins for [Herdr](https://herdr.dev).

Each top-level directory is a self-contained plugin that can be linked while
developing or installed directly from its repository subdirectory.

## Plugins

- [`file-preview`](file-preview/) previews PNG, Markdown, JSON, and text in a
  Herdr-managed terminal pane beside the agent that produced them. It replaces
  the Visual Proof plugin and accepts its legacy path environment variables.
- [`file-upload`](file-upload/) transfers local files through a local Kitty
  helper or browser drop zone and inserts their destination paths into a local
  or remote Herdr pane.
