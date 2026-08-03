# Changelog

All notable changes to S7 Lint for VS Code will be documented in this file.

## 0.1.2

- Fixed typed and radix literals being misread as tag references. The lexer
  splits `<prefix>#<value>` across several tokens (`16#EFEF` becomes
  `16` + `#EFEF`), and the guard that told a literal tail from a real `#tag`
  only recognised a small set of letter prefixes, so `16#EFEF`,
  `2#1111_0000`, `BYTE#2#1111_0000` and the second half of `W#16#00FF` were
  each reported as undeclared identifiers, and the surrounding statements
  were misparsed. Literal recognition now covers the full S7-SCL "Notation
  for Constants" grammar: bare `2#`/`8#`/`16#`, spelled-out type prefixes
  (`BOOL#`, `BYTE#`, `WORD#`, `DWORD#`, `INT#`, `DINT#`, `REAL#`, `CHAR#`,
  and the S7-1500 additions) stacked with a radix prefix, signed and quoted
  values, exponent floats (`4e2`, `3.0E+10`), dates, durations with unit
  suffixes, and times of day.
- Consolidated the three drifted copies of that literal-scanning logic into
  one shared module, and added a fixture covering the whole notation grammar
  so it cannot drift again.
- Added a quick fix for `missing-required-pin` that marks a pin optional in
  the instruction registry, individually or all unfilled pins on a call at
  once, for when a pin table was transcribed as required but the parameter
  is not.
- Added a quick fix for `unknown-instruction` that scaffolds a registry entry
  for the call, seeding its pin names from the call site. Scaffolds are
  written as `confidence: shape-only` with every pin optional and no data
  types, so they never assert more than the call site proves.
- Saving in the Instruction Registry Editor now reloads the rule set and
  re-lints open files immediately; previously the change only took effect
  after reloading the window. A `system-types.yaml` save also rebuilds the
  workspace type cache.
- Both registry quick fixes, and the editor opened from their confirmation,
  land directly on the affected entry with the tree expanded to it.
- Fixed the pin **Name** field being unusable in the Instruction Registry
  Editor: a `width: 100%` control rule collapsed it inside the flex header
  row. The field is now labelled alongside **Dir**, and the same header row
  used by Template extra pragmas and system-type members, which had lost its
  flex layout entirely, lays out correctly again.
- Reduced editor save churn: an edited entry re-serialises in the registry's
  own sequence-indent and quote style, so a small change no longer rewrites
  every line of the entry.
- Corrected `GET`/`PUT` in the SCL registry: only the `ADDR_1`/`SD_1` pair is
  required, not `ADDR_2..4`/`SD_2..4`.
- Added the SCL `PEEK`/`POKE` family.

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
