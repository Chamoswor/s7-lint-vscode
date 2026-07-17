# Timer Operations

Source: [`timers.s7dcl`](reference-exports/timers.s7dcl) / [`timers.s7res`](reference-exports/timers.s7res).

Two call shapes exist for every timer type (`TP`, `TON`, `TOF`, `TONR`):
the **instance-call** form (full control, explicit `pt`/`et`) and the
**coil** form (compact, drives the timer straight off a coil-like box).
Both need a `time_type` template.

## Instance-call form

Declared with the typed name (`TP_TIME`, `TON_TIME`, `TOF_TIME`,
`TONR_TIME`), called through the base name:

```
VAR
    TIME_Optional : Time;
    TP_TIME_Instance : TP_TIME;
    TON_TIME_Instance : TON_TIME;
    TOF_TIME_Instance : TOF_TIME;
    TONR_TIME_Instance : TONR_TIME;
END_VAR
VAR CONSTANT
    TIMEC1 : Time := T#100ms;
END_VAR

RUNG #T1
    { S7_Templates := "time_type := Time" }
    #TP_TIME_Instance.TP( pt := #TIMEC1, et => #TIME_Optional )     -- TP: pulse
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    #TON_TIME_Instance.TON( pt := #TIMEC1, et => #TIME_Optional )   -- TON: on-delay
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    #TOF_TIME_Instance.TOF( pt := #TIMEC1, et => #TIME_Optional )   -- TOF: off-delay
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    #TONR_TIME_Instance.TONR(    -- TONR: accumulating on-delay, needs an explicit reset
        r := #T2,
        pt := #TIMEC1,
        et => #TIME_Optional
    )
END_RUNG
```

The RUNG's leading condition is always the timer's `IN` pin (implicit,
not written as `in :=`) — the fixture corpus's `FB_Pump`/`FB_MotorProtection` use
this form throughout, e.g. `RUNG #tTripRaw ... #tonDeb.TON(pt := #i_tDebounce, et => )`.
`Q` is likewise implicit: whatever follows the timer call in the same
RUNG (a `Coil`, another box) receives the timer's `Q` output as its
input. This is how the self-resetting-1s-tick idiom works:

```
RUNG #tonTickTrg
    { S7_Templates := "time_type := Time" }
    NOT #tonTick.TON( pt := T#1s, et =>  )
    Coil( #tTickPulse )
    Coil( #tonTickTrg )
END_RUNG
```
(`tonTickTrg` mirrors last scan's `Q`; `IN := NOT tonTickTrg` retriggers
every time `Q` was true last scan, producing a free-running 1 s pulse —
`tTickPulse`/`tonTickTrg` are both driven off the same `Q` this scan.)

## Coil form

Drives a **previously-declared instance** from a bare coil box — no
separate `IN` needed, the coil box itself is the trigger, `timer =>`
names which instance it targets:

```
RUNG #T1
    { S7_Templates := "time_type := Time" }
    TP_Coil( timer => #TP_TIME_Instance, pt := #TIMEC1 )
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    TON_Coil( timer => #TON_TIME_Instance, pt := #TIMEC1 )
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    TOF_Coil( timer => #TOF_TIME_Instance, pt := #TIMEC1 )
END_RUNG
RUNG #T1
    { S7_Templates := "time_type := Time" }
    TONR_Coil( timer => #TONR_TIME_Instance, pt := #TIMEC1 )
END_RUNG
```

## Reset / load-time-only coils

```
RUNG #T1
    RT_Coil( #TP_TIME_Instance )    -- Reset timer (any of the four types)
END_RUNG
RUNG #T1
    PT_Coil( timer => #TP_TIME_Instance, PT := #TIMEC1 )   -- Load duration only
END_RUNG
```
