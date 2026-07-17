# Counter Operations

Source: [`counters.s7dcl`](reference-exports/counters.s7dcl) / [`counters.s7res`](reference-exports/counters.s7res).

Counter instances should be declared `VAR RETAIN` (real exports do —
counters are meant to survive a warm restart). Declared with the typed
name (`CTU_INT`, `CTD_INT`, `CTUD_INT`), called through the base name
(`.CTU`, `.CTD`, `.CTUD`), with a `value_type` template for the counted
type:

```
VAR RETAIN
    CTU_INT_Instance : CTU_INT;
    CTD_INT_Instance : CTD_INT;
    CTUD_INT_Instance : CTUD_INT;
END_VAR
VAR CONSTANT
    NUM1 : Int := 5;
END_VAR

RUNG #Count
    { S7_Templates := "value_type := Int" }
    #CTU_INT_Instance.CTU(       -- CTU: Count up
        r := #Reset,
        pv := #NUM1,
        cv =>  
    )
END_RUNG
RUNG #Count
    { S7_Templates := "value_type := Int" }
    #CTD_INT_Instance.CTD(       -- CTD: Count down
        ld := #Load,
        pv := #NUM1,
        cv =>  
    )
END_RUNG
RUNG #CountUp
    { S7_Templates := "value_type := Int" }
    #CTUD_INT_Instance.CTUD(     -- CTUD: Count up/down
        cd := #CountDown,
        r := #Reset,
        ld := #Load,
        pv := #NUM1,
        qd =>  ,
        cv =>  
    )
END_RUNG
```

The RUNG's leading condition is the counter's **count-event** input
(`CU` for `CTU`/`CTUD`, implicit as the rung driving the box) — `r`/`ld`
are the reset/load pins, spelled out explicitly since they don't have a
natural "rung flow" slot the way the primary count pulse does.
