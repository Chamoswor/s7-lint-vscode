# Accessing a "slice" of a tagged data type

Transcribed from Siemens' S7-1200 manual, "PLC concepts > Data types >
Accessing a slice of a tagged data type"
(docs.tia.siemens.cloud/.../plc-concepts/data-types/accessing-a-slice-of-a-tagged-data-type).

PLC tags and data block tags can be accessed at the bit, byte, or word
level depending on **the tag's storage size**, independent of its
declared type name. This is new grammar the lint server needs to
recognize — it's a suffix on a tag reference, not a separate box/pin
concept from `instruction-registry/`.

## Syntax

```
"<PLC tag name>".xn        -- bit access
"<PLC tag name>".bn        -- byte access
"<PLC tag name>".wn        -- word access
"<Data block name>".<tag name>.xn
"<Data block name>".<tag name>.bn
"<Data block name>".<tag name>.wn
```

`n` is a numeric index — see the size-keyed bounds table below.

## Valid index ranges, by tag storage size

This is keyed by the tag's `sizeBits` (from `base-types.yaml`), **not**
by type name — any 32-bit type (`DWord`, `DInt`, `UDInt`, `Real`, `Time`,
`TOD`, ...) supports the same slicing as any other 32-bit type:

| Tag size | Bit slice (`.xn`) | Byte slice (`.bn`) | Word slice (`.wn`) |
|---|---|---|---|
| 8 bits (Byte-sized) | `.x0` – `.x7` | `.b0` | — (too small for a word slice) |
| 16 bits (Word-sized) | `.x0` – `.x15` | `.b0` – `.b1` | `.w0` |
| 32 bits (DWord-sized) | `.x0` – `.x31` | `.b0` – `.b3` | `.w0` – `.w1` |

A linter should compute the applicable row from the referenced tag's
resolved `sizeBits` (via the type cache — see `udt-dependency-cache.md`
for how a `#tag`/`"DB".tag` reference resolves to a concrete type) and
flag:

- a slice index outside the row's range for that tag's size (e.g.
  `"MyWordTag".x20` on a 16-bit tag — max index is 15),
- a `.wn`/`.bn` slice attempted on a tag too small to support it (e.g.
  `.w0` on an 8-bit `Byte` tag),
  - a slice attempted on a tag whose size isn't 8/16/32 bits at all
  (`Bool`, `String`, `Array`, `Struct`, 64-bit types, ...) — not
  documented as valid for any size outside this table; treat as an
  error unless confirmed otherwise for a specific type.

## Notes

- This applies to **PLC tags and data block tags** specifically — not
  confirmed whether it also applies to `VAR_TEMP`/local block variables
  the same way; verify before linting local-variable slices the same as
  DB/PLC-tag slices.
- Slice results can be used anywhere a bit/byte/word operand of that
  size is expected — i.e. a `.x0` slice is just a `Bool` operand for
  every purpose downstream (e.g. as an `A(in2 := ...)` pin in
  `instruction-registry/01-bit-logic.yaml`).
- `String` does NOT support this `.xn`/`.bn`/`.wn` grammar (it isn't
  8/16/32 bits — see the last bullet under "Valid index ranges" above)
  — it has its own, DIFFERENT single-character indexing syntax instead,
  see the next section.

## Single-character access on `String` (a separate grammar)

Confirmed 2026-07-13 via Siemens' "Equal" (CMP ==) comparator reference
page, in the context of comparing individual string characters — NOT
the same mechanism as the `.xn`/`.bn`/`.wn` grammar above (String isn't
one of that grammar's 8/16/32-bit sizes to begin with).

```
<String tag name>[n]     -- e.g. MyString[2]
```

- `n` selects one character of a `String`-typed operand; the result
  behaves as a `Char` operand.
- Only confirmed **1-indexed** from a single worked example
  (`MyString[2]` described as "the second character") — index-0
  behavior, upper bound (does it follow the string's declared max
  length, `String[n]`, or its current runtime length?), and whether
  an out-of-range index is a compile error or a runtime condition are
  all still unconfirmed. Don't assume 0-indexing or silently-clamped
  bounds without checking a real compiled example.
- Only confirmed as a comparator operand so far (`EQ_Contact` and,
  presumably, its five `*_Contact` siblings per
  `instruction-registry/02-comparators.yaml`'s file header). Not yet
  confirmed to work as a general String-typed operand anywhere else a
  Char value is expected (e.g. as a `Move` source, or a bit-logic pin) —
  verify before assuming it generalizes past comparator operands.
- Not confirmed whether this applies to `WString` too (its element type
  is `WChar`, twice the width of `String`'s `Char` — the bracket
  arithmetic may or may not carry over unchanged).
