# Conversion Operations

Source: [`conversion.s7dcl`](reference-exports/conversion.s7dcl) for call shape
(no `.s7res`; that reference block was created, used to confirm call
shape, then deleted from the TIA project again — it was never meant to
compile with blank pins, see the template caveat below). Formulas and
official parameter semantics below are from Siemens' own instruction
help pages.

```
Convert( in :=  , out =>  )                         -- explicit type conversion
Round( in :=  , out =>  )                           -- round to nearest, ties-to-even
Ceil( in :=  , out =>  )                             -- round up (next higher integer)
Floor( in :=  , out =>  )                            -- round down (next lower integer)
Trunc( in :=  , out =>  )                            -- truncate toward zero (drop decimals)
Scale( min :=  , value :=  , max :=  , out =>  )     -- 0.0..1.0 fraction -> min..max range
Normalize( min :=  , value :=  , max :=  , out =>  ) -- min..max range -> 0.0..1.0 fraction
```

## Official semantics

- **`Convert`**: reads `IN`, converts to the data type set on the box,
  writes `OUT`. `ENO = 0` on overflow or if `EN = 0`. Any bit
  string/integer/float/CHAR/BCD combination the box lets you pick is
  valid; DWORD/LWORD can (on S7-1500) only convert to/from REAL/LREAL.
- **`Round`**: nearest integer, **ties round to the even value**
  (banker's rounding) — `1.5 → 2`, but also `2.5 → 2` (not 3).
- **`Ceil`**: next higher integer, `output >= input` always (`0.5 → 1`,
  `-0.5 → 0`).
- **`Floor`**: next lower integer, `output <= input` always (`0.5 → 0`,
  `-0.5 → -1`).
- **`Trunc`**: drops the decimal part toward zero (`1.5 → 1`, `-1.5 → -1`)
  — different from `Floor` for negative numbers.
- **`Normalize`**: `OUT = (VALUE - MIN) / (MAX - MIN)`. `ENO = 0` if
  `MIN >= MAX`, `VALUE` is NaN, or the float result is out of IEEE-754
  range. If you pass constants for `MIN`/`VALUE`/`MAX`, only one needs
  an explicit declared type — the others infer it.
- **`Scale`**: `OUT = [VALUE * (MAX - MIN)] + MIN`. Same `ENO = 0`
  conditions as `Normalize`, plus overflow. `VALUE` must be a
  floating-point fraction (typically the `Normalize` output); `MIN`/
  `MAX`/`OUT` can be integer or float.

None of `Round`/`Ceil`/`Floor`/`Trunc` change the *value*'s magnitude —
they only pick which integer a fractional value maps to. Use `Round`
for statistics/display, `Trunc`/`Floor`/`Ceil` when the direction of
rounding error matters (e.g. never round a safety limit the wrong way).

## `Convert` needs a bracketed, combined `SrcType`/`DestType` template

Unlike single-type generics (comparators use `SrcType`, counters/MIN/MAX
use `value_type`), `Convert` needs **both** source and destination type
in one attribute, using **square brackets** with comma separation (not
semicolons):

```
{ S7_Templates := "[SrcType := LReal, DestType := Real]" }
Convert( in := #tDeltaT, out => #tDeltaTReal )
```

Confirmed against real TIA FBD editor output for the fixture corpus's
`FB_ControlValve.s7dcl` (the box shows e.g. `CONV / LReal to Real` under
its name once wired — export it after wiring to see the exact
attribute TIA writes, don't guess the bracket-vs-semicolon format).
`Round`/`Ceil`/`Floor`/`Trunc` are presumably generic the same way
(they also show a `<Type> to <Type>` label per the official examples,
e.g. `ROUND / REAL to DINT`) — not yet confirmed in the fixture corpus's own
`.s7dcl` output, verify before relying on it.

## `Normalize`/`Scale` — the idiomatic way to do analog scaling, confirmed (`FB_ControlValve.s7dcl`)

Both need the same bracketed `[SrcType := X, DestType := Y]` template
shape as `Convert`. The type roles differ between the two boxes:

- **`Normalize`** (raw value → 0.0–1.0 fraction): `value`/`min`/`max`
  are typed as `SrcType` (the raw value's own type); `out` is typed as
  `DestType` (always `Real` in practice — it's a fraction).
- **`Scale`** (0.0–1.0 fraction → raw value): `value` is typed as
  `SrcType` (the fraction, `Real`); `min`/`max`/`out` are typed as
  `DestType` (the target raw type).

Real round-trip example — command (`Real` 0..100%) out to a raw analog
value (`Int` 0..27648), and a raw feedback (`Int` 0..27648) back to
percent (`Real` 0..100), both unconditional in one rung each:

```
RUNG
    { S7_Templates := "[SrcType := Real, DestType := Real]" }
    Normalize( min := 0.0, value := #statCmd, max := 100.0, out => #tNormalized )
    { S7_Templates := "[SrcType := Real, DestType := Int]" }
    Scale( min := 0, value := #tNormalized, max := 27648, out => #q_iOutRaw )
END_RUNG
RUNG
    { S7_Templates := "[SrcType := Int, DestType := Real]" }
    Normalize( min := 0, value := #i_iFbRaw, max := 27648, out => #tNormalized )
    { S7_Templates := "[SrcType := Real, DestType := Real]" }
    Scale( min := 0.0, value := #tNormalized, max := 100.0, out => #tFbReal )
END_RUNG
```

Note `min`/`max` literals switch between integer (`0`, `27648`) and real
(`0.0`, `100.0`) form to match whichever side (`SrcType` for `Normalize`,
`DestType` for `Scale`) they belong to — get this wrong and expect
"Please select a data type" errors.

## Does this category simplify a rate-limiting ramp network?

Checked against `FB_ControlValve.s7dcl`'s Network 2 ("Rampe") — the
slew-rate limiter that clamps `statCmd`'s step-per-scan to
`i_rRateLimit * elapsed_seconds`. **No** — that network stays entirely
in floating-point (`Real`/`LReal`) space; nothing in it ever converts a
float to an integer, so `Round`/`Ceil`/`Floor`/`Trunc` don't apply
there (they're only relevant where a `Real` becomes an `Int`, e.g. the
`Scale` call in the *output-scaling* network). The one conversion the
ramp network does need — `Runtime`'s `LReal` elapsed-time → `Real` for
arithmetic with the `Real`-typed rate limit — is already the right tool
(`Convert`, a precision-only cast, not a rounding operation).

The one genuine simplification available for that network is unrelated
to conversions: [05-Math.md](05-Math.md)'s `Limit(min:=, in:=, max:=,
out=>)` box replaces the `MAX` + `MIN` two-box clamp (`Neg` for the
negative bound is still needed) — confirmed compiling clean in
`FB_ControlValve.s7dcl`'s ramp network.
