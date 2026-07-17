# Bit Logic Operations

Source: [`bit-logic.s7dcl`](reference-exports/bit-logic.s7dcl) / [`bit-logic.s7res`](reference-exports/bit-logic.s7res).

## AND / OR / XOR

```
RUNG #t1
    A( in2 := #t2 )      -- &: AND
    Coil( #t3 )
END_RUNG
RUNG #t1
    O( in2 := #t2 )      -- >=1: OR
    Coil( #t3 )
END_RUNG
RUNG #t1
    X( in2 := #t2 )      -- X: EXCLUSIVE OR
    Coil( #t3 )
END_RUNG
```

`in1` is always the incoming power flow (the RUNG's leading token or the
previous box); only `in2` is ever written explicitly. Chain more
`A(in2:=...)` boxes to AND more than two terms.

⚠️ **`in1` is not optional — it does not default to "always true".** If
the RUNG starts bare (no leading condition) and the first box is
`A(in2 := #x)`, TIA leaves `in1` unconnected and compile fails with "The
operand required at the input or output is missing" (confirmed via a
real TIA-generated screenshot showing the unconnected pin as `<??.?>` in
red). `in1` must come from *somewhere* — either the RUNG's leading token
or a preceding box in the chain.

This matters because of a second rule (see [00-Overview.md](00-Overview.md)):
a bare leading condition **cannot** be placed directly before a plain
function box like `Move` — it needs an `A`/`O` contact in between. So to
gate `Move` (or `Add`/`Sub`/...) on exactly *one* condition, keep that
condition as the RUNG's leading token and drop in a **bare, argument-less**
`A()` as the pass-through contact — `in2` doesn't need to be given
anything if there's no second term:

```
RUNG #cond
    A()                     -- pass-through: in1 = cond (from RUNG), no in2 needed
    Move( in := #x, out1 => #y )
END_RUNG
```

For a **negated** single condition, keep the *same* leading condition
and prefix the pass-through `A()` with `NOT` — confirmed via a real
compiled-and-verified example in the fixture corpus's `FB_ControlValve.s7dcl`:

```
RUNG #cond
    NOT A()                 -- NOT(pass-through of cond) = NOT cond
    Move( in := #x, out1 => #y )
END_RUNG
```

(`RUNG TRUE` + `A(in2 := NOT #cond)` also compiles, but `RUNG #cond` +
`NOT A()` is what TIA itself generates and is simpler: same leading
condition on both the positive and negated branch, only the `NOT` and
the box body differ.)

## Assignment / negate / coils

```
RUNG
    Coil( #t1 )              -- Assignment: t1 := <rung result>
END_RUNG
RUNG
    NOT Coil( #t2 )          -- Negate assignment: t2 := NOT <rung result>
END_RUNG
RUNG
    I_Coil( #t1 )            -- "Invert RLO" negated coil variant
END_RUNG
RUNG
    R_Coil( #s1 )            -- Reset output (non-edge, unconditional while active)
END_RUNG
RUNG
    S_Coil( #s1 )            -- Set output
END_RUNG
```

## Bitfield set/reset (SET_BF / RESET_BF)

Sets/resets `n` consecutive bits starting at `operand`. Needs a constant
(`VAR CONSTANT`) for the bit count, and typically targets a DB array via
a quoted cross-block reference:

```
VAR CONSTANT
    const_uint1 : UInt := 5;
END_VAR
...
RUNG
    S_BitfieldCoil(
        operand => "CLAUDE_DB_REF".array_bool[0],
        n := #const_uint1
    )
END_RUNG
RUNG
    R_BitfieldCoil(
        operand => "CLAUDE_DB_REF".array_bool[0],
        n := #const_uint1
    )
END_RUNG
```

## SR / RS flip-flops

`S_SR` = "SR: Set/reset flip-flop" (dominant reset when both active via
its wiring order); `S_RS` = "RS: Reset/set flip-flop" (dominant set).
The unconnected secondary input is still listed, blank:

```
RUNG #t1
    S_SR(
        operand := #s1,
        r1 :=  
    )
END_RUNG
RUNG #t1
    S_RS(
        operand := #s1,
        s1 :=  
    )
END_RUNG
```

## Edge detection on an operand (P / N contacts and coils)

`P_Contact` / `N_Contact` scan an **operand** for a rising/falling edge
and store the previous-scan memory bit in `bit`:

```
RUNG
    P_Contact( operand := #t1, bit := #s1 )   -- P: positive edge scan
    Coil( #t2 )
END_RUNG
RUNG
    N_Contact( operand := #t1, bit := #s1 )   -- N: negative edge scan
    Coil( #t2 )
END_RUNG
```

`P_Coil` / `N_Coil` set an **operand** on the edge of the incoming rung
signal (note the `operand =>` output arrow — the coil writes to it):

```
RUNG #t1
    P_Coil( operand => #t2, bit := #s1 )      -- P=: set on positive edge
    Coil( #t3 )
END_RUNG
RUNG #t1
    N_Coil( operand => #t2, bit := #s1 )      -- N=: set on negative edge
    Coil( #t3 )
END_RUNG
```

## Edge detection on the RLO (P_Trig / N_Trig)

Scans the rung's result-of-logic-operation directly (no separate
operand needed) and writes the previous-scan memory into the given bit:

```
RUNG #t1
    P_Trig( #s1 )   -- P_TRIG: scan RLO for positive edge
END_RUNG
RUNG #t1
    N_Trig( #s1 )   -- N_TRIG: scan RLO for negative edge
END_RUNG
```

## R_TRIG / F_TRIG instances

Declared as named instances (`VAR`), called with `.R_TRIG(...)` /
`.F_TRIG(...)`, `clk`/`q` explicit. Note the `RUNG TRUE` idiom — used
when the instance itself should evaluate every scan, not gated by a
condition:

```
VAR
    R_TRIG_Instance : R_TRIG;
    F_TRIG_Instance : F_TRIG;
END_VAR
...
RUNG TRUE
    #R_TRIG_Instance.R_TRIG( clk := #t1, q => #t2 )
END_RUNG
RUNG TRUE
    #F_TRIG_Instance.F_TRIG( clk := #t1, q => #t2 )
END_RUNG
```

`FB_Pump`/`FB_MotorProtection` in this project instead drive `R_TRIG`
instances straight off a condition (`#trigStart.R_TRIG(clk := #i_xCmdStart, q => )`)
without the `RUNG TRUE` wrapper — both forms work; `RUNG TRUE` is only
needed when there's no natural leading condition to hang the RUNG off.
