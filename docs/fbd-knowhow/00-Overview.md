# FBD `.s7dcl` Source Syntax — Know-how

This documents the **plain-text SD source format** used for LAD/FBD blocks
(`.s7dcl` + `.s7res` pairs, produced when `tiaImport.exportFormat` is
`sd`). This is a *different* thing from the SimaticML XML format used by
raw Openness exports; that XML represents `SW.Blocks.CompileUnit` /
`FlgNet`. This folder
documents the textual `NETWORK ... RUNG ... END_NETWORK` DSL that TIA
Portal's `ExportAsDocuments` / SD source import actually reads and writes
for LAD/FBD blocks.

**Ground truth source**: every example in these files is copied or
adapted from real TIA-Portal-exported reference blocks
(`reference-exports/*.s7dcl` in this folder — each
one built by dragging the real instruction into TIA Portal and exporting
it). Don't hand-guess new instruction syntax; if an instruction isn't
covered here or in `reference-exports/`, create a tiny throwaway FB in TIA
Portal with that instruction, export it as SD, and add the real syntax
here.

## File map

- [01-Bit-Logic.md](01-Bit-Logic.md) — A/O/X, coils, SR/RS flip-flops, edge detection
- [02-Comparators.md](02-Comparators.md) — EQ/NE/GT/LT/GE/LE, IN_RANGE, OK/NOT_OK
- [03-Counters.md](03-Counters.md) — CTU/CTD/CTUD
- [04-Timers.md](04-Timers.md) — TP/TON/TOF/TONR (instance + coil forms)
- [05-Math.md](05-Math.md) — Calculate, Add/Sub/Mul/Div, trig, Sqrt, Limit, etc.
- [06-Move.md](06-Move.md) — Move, Serialize/Deserialize, block moves, Scatter/Gather
- [07-Word-Logic.md](07-Word-Logic.md) — And/Or/Xor/Inv, DECO/ENCO, SEL/Mux/Demux
- [08-Shift-Rotate.md](08-Shift-Rotate.md) — Shr/Shl/Ror/Rol
- [09-Program-Control.md](09-Program-Control.md) — Label/Jump, Switch, Return
- [10-Runtime-Control.md](10-Runtime-Control.md) — passwords, GetError, `Runtime` (elapsed time)
- [11-Conversion-Operations.md](11-Conversion-Operations.md) — Convert, Round/Ceil/Floor/Trunc, Scale/Normalize

## Block-level structure

```
{
    S7_BlockComment := "MLC_xx";   -- optional, points into .s7res
    S7_BlockTitle := "MLC_xx";     -- optional, points into .s7res
    S7_Optimized := "TRUE";
    S7_PreferredLanguage := "FBD";
    S7_Version := "0.1"
}
FUNCTION_BLOCK "BlockName"
    VAR_INPUT ... END_VAR
    VAR_OUTPUT ... END_VAR
    VAR ... END_VAR              -- static, also VAR RETAIN for retentive instances
    VAR_TEMP ... END_VAR
    VAR CONSTANT ... END_VAR

    { S7_Language := "FBD"; S7_NetworkTitle := "MLC_xx" }
    NETWORK
        RUNG ...
        END_RUNG
    END_NETWORK
    ...
    { S7_Language := "FBD" }   -- TIA always appends one trailing empty network
    NETWORK
        RUNG
        END_RUNG
    END_NETWORK
END_FUNCTION_BLOCK
```

- **File name must equal the quoted block name** (`FB_Pump.s7dcl` ↔
  `FUNCTION_BLOCK "FB_Pump"`).
- `S7_Optimized` (not `S7_Optimized_Access` — that's the `.scl` header
  attribute; `.s7dcl` uses a different key).
- Every `NETWORK` may carry `S7_NetworkTitle` / `S7_NetworkComment`
  attributes, each pointing to an `id:` in the sibling `.s7res` file.
  Networks without any comment/title just get `{ S7_Language := "FBD" }`.
  TIA's own exports always end with one bare trailing `NETWORK` (no
  content) — keep it, it's cosmetic but matches real exports.

## `.s7res` sidecar file

```yaml
MultiLingualTexts:
  - id: MLC_xx
    en-US: Single line comment
  - id: MLC_yy
    en-US: 'Text with: a colon needs single quotes'
  - id: MLC_zz
    en-US: |-
      Multi-line block comments use a YAML block literal.
      Every continuation line is indented 6 spaces under "en-US: |-".
```

Every `S7_MLC` / `S7_NetworkTitle` / `S7_NetworkComment` / `S7_BlockTitle`
/ `S7_BlockComment` id referenced in the `.s7dcl` must have a matching
`id:` entry here. IDs are just labels — real TIA exports use random
short alnum strings (`MLC_4kK`), but human-readable ones (`MLC_FP01`)
work fine; they only need to be unique within the file.

⚠️ **Real, deterministic cause found**: `ImportFromDocuments ... The
resource file contains corrupted data or format might be invalid` is
caused by an **unquoted colon inside a plain (unquoted) YAML scalar
value**, e.g.:

```yaml
  - id: MLC_x
    en-US: Live-tilstand: vern utloest (etter debounce)   # ✗ breaks the parser
```

Fix by single-quoting the whole value:

```yaml
  - id: MLC_x
    en-US: 'Live-tilstand: vern utloest (etter debounce)'  # ✓ correct
```

This is easy to miss because only *some* colon-containing values in a
file need quoting by convention (e.g. `'TRUE: ... FALSE: ...'`), so a
one-off mid-sentence colon (`"Live-tilstand: ..."`) is an easy spot to
forget. **Rule: any `en-US:` value that contains a `:` anywhere in the
text must be wrapped in single quotes, no exceptions** — check every
line, not just the ones that "look like" they need it.

This was confirmed by bisection on two separate blocks
(`FB_MotorProtection`, `FB_FlowMonitor` in this project): removing/quoting
the one offending line was the only change needed to turn a
deterministically-failing import into a passing one. An earlier version
of this note claimed the error was "transient" based on a retry that
happened to succeed — that was a misread; retries are not reliable and
the actual fix is to find and quote the unquoted colon.

Multi-line block literals (`en-US: |-`) are **not** affected — colons
inside a block scalar's body are plain text, no quoting needed there.

## RUNG / expression structure

A `RUNG` is one FBD signal path, read like a ladder rung. The first
token after `RUNG` is the "power rail" input — either omitted (line
starts straight with an instruction, meaning "always evaluate"), a
literal `TRUE`, a variable/`#temp`, or a `wire#label` (see below).

```
RUNG #condition
    A( in2 := #other )      -- in1 is implicit: whatever the RUNG started with
    Coil( #result )
END_RUNG
```

- **Binary boxes only ever show `in2`** (`A`, `O`, `X`) — `in1` is
  always the incoming power flow from the RUNG (or the previous box in
  the chain). To AND/OR more than two terms, chain more `A(in2:=...)` /
  `O(in2:=...)` boxes in sequence, or branch through a `wire#` (below).
- **Multiple coils in one RUNG** are legal and all get driven by the
  same upstream signal: `Coil(#a) Coil(#b)` at the end of one rung
  assigns both from the same condition.
- **Any box with `EN`/`ENO` pins can be chained in the same RUNG** — which
  in practice means almost every function box (`Move`, `Add`, `Convert`,
  `Normalize`, `Scale`, `MIN`/`MAX`, `Abs`, `Neg`, ...): TIA links each
  box's `EN` to the previous box's `ENO` (or the RUNG's leading flow for
  the first one) automatically, without needing an explicit contact/coil
  between them. Real confirmed example from `FB_ControlValve.s7dcl`,
  `Normalize` feeding a temp var that `Scale` reads, both unconditional,
  in the same rung:
  ```
  RUNG
      Normalize( min := 0.0, value := #statCmd, max := 100.0, out => #tNorm )
      Scale( min := 0, value := #tNorm, max := 27648, out => #q_iOutRaw )
  END_RUNG
  ```
  Splitting each into its own RUNG (as earlier revisions of this doc
  recommended out of caution) also works — it's just not required.
- **`NOT`** prefixes a box to invert its result: `NOT Coil(#x)`,
  `NOT #tonTick.TON(...)`.
- **Sub-expressions / branches** are built by giving a *second* `RUNG`
  (with no leading condition of its own, or its own condition) a
  `wire#label` suffix after `END_RUNG`, then referencing
  `wire#label` as an `in2 :=` (or as the leading power-rail token of
  another RUNG) elsewhere:

  ```
  RUNG #a
      A( in2 := wire#w1 )     -- "a AND (whatever wire#w1 computes)"
      Coil( #out )
  END_RUNG
  RUNG #b
      A( in2 := NOT #c )       -- "b AND NOT c"
  END_RUNG wire#w1              -- ← this RUNG's result becomes wire#w1
  ```

  `wire#` labels are scoped to a single `NETWORK` — reusing `wire#w1` in
  a different `NETWORK` is a fresh label, not a conflict. A `wire#` label
  can also be dropped **inline mid-rung** (not just after `END_RUNG`) to
  tap an intermediate point in a chain for reuse elsewhere — see
  `FB_DualPump.s7dcl`'s pump-selection network for a real example of
  `wire#w5`/`wire#w6` taps appearing between `A(...)` boxes.

- **A leading RUNG condition can only be followed directly by a
  contact-family box (`A`/`O`/`X`/`P_Contact`/comparators), a coil
  (`Coil`/`S_Coil`/`R_Coil`/...), or an instance call (timer/counter/
  trigger).** It **cannot** be followed directly by a plain function box
  (`Move`, `Add`, `Sub`, `Convert`, ...) — that's a genuine parse error
  (`no viable alternative at input '#cond\n Move'`), not just bad style.
  To gate a function box on exactly one condition, keep the condition as
  the RUNG's leading token and drop in a bare, **argument-less** `A()` as
  the pass-through contact — confirmed via a real compiled example in
  the fixture corpus's `FB_ControlValve.s7dcl`:
  ```
  RUNG #cond                            -- ✗ RUNG #cond \n Move(...) fails directly
      A()                                -- ✓ pass-through: in1 = cond, no in2 needed
      Move( in := #x, out1 => #y )
  END_RUNG
  ```
- **`NOT` can never be the leading token of a RUNG** (`RUNG NOT #cond`
  is a parse error) — it can only appear *inside* a box, either prefixing
  a whole box (`NOT Coil(#x)`, `NOT #tonTick.TON(...)`, `NOT A()`) or
  inline as a plain negated value (`A(in2 := NOT #c)`, `O(in2 := NOT #c)`).
  To gate a function box on a **negated** single condition, keep the
  *same* leading condition and prefix the pass-through contact with
  `NOT`:
  ```
  RUNG #cond
      NOT A()                            -- NOT(pass-through of cond) = NOT cond
      Move( in := #x, out1 => #y )
  END_RUNG
  ```
  See [01-Bit-Logic.md](01-Bit-Logic.md) for the full writeup — including
  why `in1` never defaults to true and must always come from somewhere.

## Instance vs. library-instruction calls

Two different call shapes appear:

1. **Multi-instance calls to your own FB types** use the FB's own
   parameter names verbatim:
   ```
   #fbMotorvern(
       i_xMprSignal := #raw,
       i_xAckAlarm := #ack,
       q_xTrip =>  ,
       q_xAlarmGroup =>  
   )
   ```
2. **System library instructions** (timers, counters, triggers) are
   declared with a *typed* name (`TON_TIME`, `CTU_INT`, `R_TRIG`) but
   *called* through the base instruction name after a dot:
   ```
   tonDeb : TON_TIME;      -- declaration
   ...
   #tonDeb.TON( pt := #t, et =>  )     -- call — note ".TON", not ".TON_TIME"
   ```
   Same pattern for `CTU_INT` → `.CTU(...)`, `CTD_INT` → `.CTD(...)`,
   `CTUD_INT` → `.CTUD(...)`, `R_TRIG`/`F_TRIG` → called as themselves
   (`.R_TRIG(...)` / `.F_TRIG(...)`, no separate base name there).

Unconnected output pins are still listed, just left blank:
`q_xTrip =>  ` (two trailing spaces then newline is the exact style TIA
itself emits — cosmetic only, not required for a valid import).

## Generic/typed instruction templates

Several instruction families are generic over a data type and need an
explicit `S7_Templates` attribute immediately before the box, naming the
template parameter TIA uses internally for that family:

| Family | Template key | Instructions |
|---|---|---|
| Comparators | `SrcType` | `EQ_Contact`, `NE_Contact`, `GT_Contact`, `LT_Contact`, `GE_Contact`, `LE_Contact`, `InRange`, `OutRange` |
| Timers | `time_type` | `TP`/`TON`/`TOF`/`TONR` calls and their `xx_Coil` forms |
| Counters | `value_type` | `CTU`/`CTD`/`CTUD` calls |
| `MIN`/`MAX`/`Limit` (clamp family) | `value_type` + `S7_GenerateENO := "TRUE"` | see [05-Math.md](05-Math.md) |
| `Neg`/`Abs` (signed single-input) | `SrcType` | see [05-Math.md](05-Math.md) — `Add`/`Sub`/`Mul`/`Div` do **not** need one |
| `Convert`/`Normalize`/`Scale` | `SrcType` **and** `DestType`, bracketed | see [11-Conversion-Operations.md](11-Conversion-Operations.md) — different syntax shape from every other template! |
| Some Move ops | `S7_GenerateENO := "TRUE"` | `Lower_Bound`, `Upper_Bound` (ENO flag, not a type template) |

```
{ S7_Templates := "SrcType := Time" }
GT_Contact( in1 := #i_tAutoStop, in2 := T#0s )
```

Three different attribute *shapes* exist depending on the family — don't
assume they're interchangeable:
```
{ S7_Templates := "SrcType := Time" }                         -- single key
{ S7_Templates := "value_type := Real"; S7_GenerateENO := "TRUE" }  -- semicolon-joined, two attributes
{ S7_Templates := "[SrcType := LReal, DestType := Real]" }     -- bracketed, comma-joined (Convert only)
```

**Whether a box needs a template at all is not predictable from the
blank-pin reference dumps in `reference-exports/`** — those files only prove
the call *shape* (box/pin names), not whether they compile standalone.
The only reliable way to know is to wire the box up for real in the TIA
FBD editor: boxes needing no template show `Auto (<Type>)` under their
name once wired; boxes needing one show a fixed/wrong type or an error
until the template is added. When genuinely unsure, ask for a quick
real-usage screenshot or export rather than guessing.

## Cross-block / DB references

A qualified reference to another block's member uses the block name in
quotes, dot, member (array index in brackets):

```
"CLAUDE_DB_REF".array_bool[0]
```

## Known destructive bridge behavior

A documented bridge incident established that
single-file `import_file` calls **delete any existing block with the
same name** before recreating it (normal for SD regeneration) — this is
expected. What's *not* obvious: it can also delete a different,
same-TIA-group block that isn't present in the specific local subfolder
you're importing from. Check `list_blocks` before/after a bridge import
if you're touching a group that's split across `SCL/`/`FBD/` subfolders.
