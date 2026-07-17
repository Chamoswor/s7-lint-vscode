# Runtime Control Operations

Source: [`runtime-control.s7dcl`](reference-exports/runtime-control.s7dcl) (no `.s7res`).

Note the inconsistent casing — these box names are **not** all-caps despite
looking like classic AWL mnemonics; match case exactly as shown:

```
ENDIS_PW(
    REQ :=  ,
    F_PWD :=  ,
    FULL_PWD :=  ,
    R_PWD :=  ,
    HMI_PWD :=  ,
    Ret_Val =>  ,
    F_PWD_ON =>  ,
    FULL_PWD_ON =>  ,
    R_PWD_ON =>  ,
    HMI_PWD_ON =>  
)                          -- lock/unlock CPU access-level passwords

RE_TRIGR()                 -- restart cycle monitoring time, no pins
STP()                      -- exit program, no pins

GetError( error =>  )      -- get error locally (CamelCase, not GET_ERROR)
GetErrorID( error =>  )    -- get error ID locally (CamelCase, not GET_ERR_ID)

INIT_RD(
    REQ :=  ,
    Ret_Val =>  
)                          -- initialize all retain data

WAIT( WT :=   )            -- configure time delay (microseconds)

Runtime(
    ret_val =>  ,
    mem :=  
)                          -- measure elapsed program runtime since last call
```

## `Runtime` — the box this project actually needed

`Runtime` (not `RUNTIME`) has exactly two pins: `mem` (an `LReal`
in/out — holds the previous-call timestamp between scans) and `ret_val`
(the elapsed time in seconds since the last call, as `LReal`). No
`S7_Templates` needed — it's not generic.

```
RUNG
    Runtime( mem := #statRtMem, ret_val => #tDeltaT )
END_RUNG
```

`statRtMem : LReal` must be a persistent (`VAR`, not `VAR_TEMP`) block
of memory — it's how the instruction tracks time across calls.

**Lesson learned**: guessing `RUNTIME(mem := ..., out => ...)` failed
compile with `Instruction 'Runtime': Pin 'ret_val' connection is
missing` — the compiler error named the exact expected pin, which is
how this was corrected. When an instruction isn't in this knowledge
base, a specific compile error naming a missing pin is a reliable way
to discover the real pin name without needing a fresh TIA export.
