# Changelog

All notable changes to S7 Lint for VS Code will be documented in this file.

## 0.1.1

- Added a visual Instruction Registry Editor (`S7 Lint: Open Instruction Registry Editor`):
  an interactive Preact-based webview for creating, editing, moving, and deleting
  instruction and system-type entries across the registry's YAML files.
  - Comment- and formatting-preserving YAML document model (only changed entries
    are re-rendered; untouched regions are copied byte-for-byte on save).
  - Schema-driven forms with validation for instruction entries, instance types,
    and system types, including drag-and-drop reordering and cross-file moves.
  - Buffered edits with undo/redo and atomic save (temp file, validate, replace).
- Added detection and handling for instance DATA_BLOCKs (`instanceOf`/
  `instructionName`), including instance-type context checking that flags
  instance types used outside a `FUNCTION_BLOCK` (`instance-type-illegal-context`).
- Fixed dotted member completion for quoted external block references
  (`"Some_DB".`), including instance DATA_BLOCKs and instructions.
- Added a quick fix and auto-create-on-accept completion for dotting into a
  bare FUNCTION_BLOCK type (`dot-access-needs-instance`): both generate the
  needed instance and repoint the reference at it in one action.
- Fixed the SCL/LAD-FBD file-language loader to route by content prefix
  instead of an `-SCL.yaml` filename suffix, eliminating false diagnostics.
- Fixed root-level completion suggestions incorrectly appearing inside a
  `BEGIN ... END_*` executable body.

## 0.1.0

- Initial public release.
- Added diagnostics and editor support for SCL, LAD/FBD declaration exports,
  PLC data types, and multilingual resources.
- Added completion, hover, definition, rename, semantic tokens, and quick fixes.
- Added runtime instruction, type, diagnostic, and system registries.
- Added automated regression and smoke-test suites.
