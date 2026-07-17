# Math Functions

Source: [`math.s7dcl`](reference-exports/math.s7dcl) (no `.s7res` — TIA didn't
generate network titles for this reference block, so no comments to
carry over; instruction names are self-explanatory).

```
Calculate( in1 :=  , in2 :=  , out =>  )   -- free-form expression box
Add( in1 :=  , in2 :=  , out =>  )
Sub( in1 :=  , in2 :=  , out =>  )
Mul( in1 :=  , in2 :=  , out =>  )
Div( in1 :=  , in2 :=  , out =>  )
Mod( in1 :=  , in2 :=  , out =>  )
Neg( in :=  , out =>  )
Inc( )                                     -- increments its own operand in place
Dec( )
Abs( in :=  , out =>  )
MIN( in1 :=  , in2 :=  , out =>  )
MAX( in1 :=  , in2 :=  , out =>  )
Limit( min :=  , in :=  , max :=  , out =>  )
Sqr( in :=  , out =>  )
Sqrt( in :=  , out =>  )
Ln( in :=  , out =>  )
Exp( in :=  , out =>  )
Sin( in :=  , out =>  )
Cos( in :=  , out =>  )
Tan( in :=  , out =>  )
Asin( in :=  , out =>  )
Acos( in :=  , out =>  )
Atan( in :=  , out =>  )
Frac( in :=  , out =>  )
Expt( in1 :=  , in2 :=  , out =>  )         -- in1 ^ in2
```

Real usage example from the fixture corpus's `FB_DualPump.s7dcl`:
`Add(in1 := #statRunSec_A, in2 := 1, out => #statRunSec_A)` for a
running-seconds accumulator. TIA Portal's UI lets you widen `Add`/`Mul`
to more than two inputs (`in3`, `in4`, ...) — not confirmed in the
reference export, so check the actual box in TIA before relying on it.

## Which boxes need a generic type template

Confirmed against real wired-and-compiled usage in the fixture corpus's
`FB_ControlValve.s7dcl` (checked directly in the TIA FBD editor — box
titles shown there make the resolved type visible under the box name,
e.g. `MUL / Auto (Real)` vs `NEG / Real`):

- **`Add`, `Sub`, `Mul`, `Div`** — `Auto (<Type>)`, no template needed.
- **`Neg`, `Abs`** (single-input signed ops) need `SrcType`:
  ```
  { S7_Templates := "SrcType := Real" }
  Neg( in := #tMaxStep, out => #tNegMaxStep )
  ```
- **`MIN`, `MAX`, `Limit`** (the clamp family) need `value_type` +
  `S7_GenerateENO := "TRUE"`:
  ```
  {
      S7_Templates := "value_type := Real";
      S7_GenerateENO := "TRUE"
  }
  Limit( min := 0.0, in := #tTarget, max := 100.0, out => #tTarget )
  ```
  `Limit` replaces a `MAX`+`MIN` two-box clamp with one box — confirmed
  in `FB_ControlValve.s7dcl` for both a plain `[0, 100]` clamp and an
  asymmetric `[-tMaxStep, +tMaxStep]` slew-rate clamp (which still needs
  a separate `Neg` to produce the negative bound first).
- Not yet confirmed either way: `Sqr`/`Sqrt`/`Ln`/`Exp`/trig/`Frac`/`Expt`
  — check before assuming.

This was easy to get wrong from [`math.s7dcl`](reference-exports/math.s7dcl) alone:
that reference block's pins were all left blank, so it never actually
compiled and the missing-type requirement never surfaced. **A reference
export with blank/unconnected pins only proves the call *shape* is
right — not that the box compiles standalone.** When in doubt, wire the
box up for real in the TIA FBD editor and read the small type label
under its name (`Auto (...)` = no template needed; anything else =
needs one), then export to see the exact attribute TIA writes.
