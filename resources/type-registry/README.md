# Type registry

This directory contains the type and expression facts loaded by the extension.
The YAML is runtime source data: edit it directly, keep provenance in the
relevant fields, and verify behavior with the automated tests.

## Files

| File | Purpose | Runtime status |
|---|---|---|
| [base-types.yaml](base-types.yaml) | elementary and IEC type names, aliases, categories, ranges, and literal forms | loaded |
| [system-types.yaml](system-types.yaml) | Siemens-defined structures and handle or identifier types | loaded |
| [category-index.yaml](category-index.yaml) | expansion of umbrella labels such as `Integers` and `Bit strings` | loaded |
| [composition-rules.yaml](composition-rules.yaml) | Array, Struct, UDT, and Variant composition constraints | loaded |
| [expression-operators.yaml](expression-operators.yaml) | SCL operator domains, result rules, and conversion policy | loaded |
| [section-legality.yaml](section-legality.yaml) | type legality by block and declaration section | loaded |
| [any-pointer.yaml](any-pointer.yaml) | legacy `Any` layout and literal rules | loaded |
| [pointer-type.yaml](pointer-type.yaml) | legacy `Pointer` layout and literal rules | loaded |
| [references.yaml](references.yaml) | `REF_TO`, `REF()`, dereference, assignment, and declaration rules | loaded |
| [symbolic-runtime-access.yaml](symbolic-runtime-access.yaml) | symbolic runtime access and matching-array constraints | loaded |
| [bcd-formats.yaml](bcd-formats.yaml) | BCD conversion formats that are not ordinary declared types | loaded |
| [slice-access.md](slice-access.md) | maintainer reference for slice and string-index syntax | documentation only |
| [named-value-types.NOTLOADED.yaml](named-value-types.NOTLOADED.yaml) | named-value-type research not yet supported by the lexer or rule loader | not loaded |
| [platform-availability.NOTLOADED.yaml](platform-availability.NOTLOADED.yaml) | CPU-family availability pending target-platform configuration | not loaded |

`src/rules/loadRules.ts` explicitly loads the eleven files marked `loaded`.
The `.NOTLOADED.yaml` suffix is intentional and prevents unfinished reference
data from being mistaken for enforced behavior.

## Schema conventions

Entries in `base-types.yaml` use a canonical type name as the key. Common
fields include `category`, `sizeBits`, `signed`, `aliases`,
`numberRepresentations`, address examples, capability flags, `confidence`,
`source`, and `notes`. Optional fields are omitted when they do not apply or
have not been established.

Other files use purpose-specific schemas represented by interfaces in
`src/rules/types.ts`. Cross-file names must use canonical casing. Keep unknown
facts absent or explicitly advisory rather than inventing placeholder values
that a runtime consumer could mistake for an enforced rule.

## Workspace type cache

Project-authored types cannot live in a static registry. The extension builds a
workspace cache from:

- `.udt` declarations;
- `.s7dcl` files whose top-level declaration is `TYPE`;
- `TYPE` declarations found in authored `.scl` files;
- `PLC data types/**/*.xml` exports.

The text and XML parsers normalize these sources into the same type-reference
model. The cache checks unknown types, duplicate declarations, circular
dependencies, array bounds, direct nested arrays, and configured nesting
limits. It also feeds symbol resolution, hover, completion, and cross-file
definition support.

The cache currently rebuilds in full when a relevant workspace file changes.
XML parsing does not retain per-member line positions, so XML diagnostics are
reported on line 1.

## How the registries work together

- `base-types.yaml` and `system-types.yaml` provide known leaf and structured
  types.
- `category-index.yaml` expands the category labels used by instruction pins.
- `composition-rules.yaml` governs arrays and structural nesting.
- `section-legality.yaml` answers where a type may be declared.
- `expression-operators.yaml` drives SCL expression compatibility.
- pointer, reference, and symbolic-runtime files provide specialized rules
  consumed by literal classification and document analysis.

Platform availability is a separate axis. Until the extension has a configured
CPU family and firmware version, platform-specific facts remain advisory and
are not enforced.

## Data ownership and evidence

Keep each fact in one authoritative place:

- Type structure, encoding, literal syntax, assignment compatibility, and
  declaration constraints belong in this directory.
- Instruction pins, call shape, EN/ENO behavior, and instruction-specific
  results belong in
  [`instruction-registry/`](../instruction-registry/README.md).
- Diagnostic wording belongs in
  [`diagnostic-registry/`](../diagnostic-registry/README.md).

Prefer concise normalized data over copied prose. Record evidence or unresolved
questions in `notes` or provenance fields, and do not convert uncertain facts
into enforced rules.

When adding a base type or category, keep `base-types.yaml` and
`category-index.yaml` consistent. Use canonical registry casing in every
cross-reference.

## Verification

Run from the `LintServer` directory:

```text
npm test
```

Use `npm run test:manifest` for focused parser and semantic-registry cases, and
`npm run test:annotated` for strict expression-type diagnostics.
