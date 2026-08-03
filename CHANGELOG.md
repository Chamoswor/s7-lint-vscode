# Changelog

All notable changes to S7 Lint for VS Code will be documented in this file.

## 0.1.3

Validated against a full, cleanly compiling S7-1500 project export (96 files).
Every diagnostic it produced was a false positive; this release removes all of
them. The two biggest causes were quoted identifiers and cross-file references.

Quoted names. Siemens quotes any identifier that isn't a legal bare one, and
the quoted spelling can appear wherever an identifier can. Each position was
its own defect, and each cascaded, because a walker that stopped at the quote
re-read the rest of the construct as something else:

- A quoted member in a dot chain (`"Db".Rec."1_Value"`) broke the chain, in the
  document index, the parser, and the syntax checker independently.
- A quoted formal parameter (`"1_Data" := ...`) fell through to the value path,
  where its own `:=` was then reported as an unexpected token.
- A quoted local tag (`#"Tag"`) lexes as two tokens; the base read as an empty
  `#`, and the name then matched the `"Block".member` external-reference shape,
  producing phantom missing-block reports and hiding the `#"Inst".Instr(...)`
  call shape entirely. A quoted name was also recorded twice, once correctly
  and once as an external reference, because the walking loop re-examined it.

Cross-file references:

- DATA_BLOCKs exported as XML are now indexed. TIA writes instance DBs in that
  format even when the FUNCTION_BLOCK they instance is text, so every reference
  to one previously resolved to nothing.
- XML exports are now discovered anywhere in the workspace. The scan was scoped
  to a `PLC data types/` folder, which a real export does not follow: DATA_BLOCK
  exports sit next to their own block, and UDT exports sit next to the code that
  uses them just as often. The narrow glob lost both -- instance DBs never
  reached the block index, and in one 96-file project 44 of the UDT exports
  never reached the type cache either.
- A LAD/FBD call to a workspace block (`"Some_DB"(...)`) is resolved against the
  workspace instead of the instruction registry, which was searched for the
  empty string and reported `Unknown instruction ''`.

Other syntax that was rejected but is valid:

- An array index on a chain member (`"Db".Units[1].Value`). This one cascaded
  worst: a single unconsumed `[` could produce hundreds of follow-on errors.
- A FUNCTION's result variable, addressed through the function's own name.
- `String[64]` and other explicit-length String/WString declarations.
- `EN`/`ENO`, which belong to the call rather than to the instruction and so
  are listed by no registry entry.
- An untyped integer constant against a bit string (`#someWord + 1`,
  `(#bits AND #mask) <> 0`). Such a constant has no domain of its own and takes
  the one its first operation gives it.
- Arithmetic on bit strings, which strict IEC rejects but TIA accepts unless a
  block's "IEC check" property is on -- a project setting no export carries.
- An instruction instance type in a `VAR_IN_OUT` section, which passes by
  reference rather than making the block own instance data.
- Any literal on a `Variant`/`Any`/`Pointer` pin: these are type-erased, so
  comparing a concrete type against them can only produce a false mismatch.

Registry corrections, all confirmed against the compiling project:

- `MB_CLIENT` required `MB_DATA_PTR` and the `RD_`/`WR_` pair simultaneously;
  they are alternative forms, so no call could satisfy all three.
- `PID_Compact`'s `Mode` is a retained InOut, not something a call must wire.
- The `POKE` family's parameter pins excluded the `L` memory area, so no block
  parameter could be passed to them. `PEEK_DWORD` had the same gap.

Retired `array-index-expression`. It claimed a variable expression is not a
legal array index; the compiling project uses such indices in several places.
The rule's own key names the LAD/FBD actual-parameter context it came from, and
the fixture cited as confirming it carried an unresolved "validate against TIA
compiler" caveat -- so the confirmation was circular. The fixture is now a
positive case, and both registries record the correction.

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
