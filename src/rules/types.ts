// Mirrors the schema documented in resources/instruction-registry/README.md
// and resources/instruction-registry/_template.yaml. Kept intentionally
// loose (optional fields) because instruction-registry entries only fill in
// facts supported by their evidence; shape-only entries may intentionally
// omit dataTypes or enEno (see that README's confidence section).

export type CallShape = "box" | "instance-dot" | "coil-ref";
export type PinDir = "in" | "out" | "inout";
export type Confidence = "confirmed-compiled" | "official-doc" | "shape-only";
export type TemplateShape = "none" | "single" | "eno-pair" | "bracketed";

export interface InstructionPin {
  name: string | null;
  dir: PinDir;
  required: boolean;
  dataTypes?: string[];
  containerKinds?: string[];
  /** Legal operand memory areas for this pin (`I`/`Q`/`M`/`D`/`L`/`P`/
   * `constant`, matching system-registry/memory.yaml's `memoryAreas` keys)
   * -- Siemens' own doc-column value, resolved against a declared operand's
   * VAR_* section via `declarationMapping`'s `tiaDocOperandArea`, NOT the
   * operand's physical storage. See system-registry/memory.yaml's
   * "matching" precedence. */
  memoryAreas?: string[];
  /** Legal VAR_* declaration sections for this pin's operand (`Input` |
   * `Output` | `InOut` | `Static` | `Temp` | `Constant`) -- takes
   * precedence over `memoryAreas` when both are set (a narrower,
   * instruction-specific restriction overriding the general mapping's
   * default), per system-registry/memory.yaml's `matching.precedence`. */
  allowedDeclarations?: string[];
  note?: string;
}

/** Mirrors system-registry/result.yaml's `resultKinds` enum. */
export type ResultKind = "none" | "value" | "inferred" | "type-expression";

export interface ResultUsage {
  storable?: boolean;
  allowedContexts?: string[];
}

/** The value (if any) an instruction/SCL call expression itself produces --
 * separate from OUT/IN_OUT pins, ENO, and instance state. See
 * system-registry/result.yaml for the full schema this mirrors. An entry
 * with no `result` field means "not yet catalogued", equivalent to
 * `{ kind: "none" }` per that file's `resultField.omittedMeans`. */
export interface ResultSpec {
  kind: ResultKind;
  dataTypes?: string[];
  rule?: string;
  sourcePins?: number[];
  transform?: string;
  usage?: ResultUsage;
  notes?: string;
}

export interface EnEnoSide {
  present: boolean;
  dataTypes?: string[];
  /** Per-platform (`"S7-1200"`/`"S7-1500"`) legal memory areas, in the same
   * value shape a pin's own `memoryAreas` uses (I/Q/M/D/L/P/T/C/constant --
   * see system-registry/memory.yaml) -- NOT free-text prose. An empty
   * array for a platform means "not yet transcribed for that platform",
   * same "don't guess" convention an empty pin `dataTypes`/`memoryAreas`
   * list already follows. */
  memoryArea?: Record<string, string[]>;
}

export interface EnEno {
  en?: EnEnoSide;
  eno?: EnEnoSide;
}

export interface TemplateSpec {
  shape: TemplateShape;
  keys: string[];
  extra: Record<string, string>;
}

/** "FBD" | "LAD" -- the `S7_Language` pragma's own values (see every real
 * export's NETWORK-level pragma). Left as `string[]` rather than a union
 * so a future language (e.g. a rarely-exported "STL") doesn't need a type
 * change here, only new registry data. */
export type InstructionLanguage = string;

export interface InstructionEntry {
  family: string;
  callShape: CallShape;
  instanceType: string | null;
  pins: InstructionPin[];
  enEno?: EnEno;
  template: TemplateSpec;
  confidence: Confidence;
  notes?: string;
  source?: string;
  /** The value the call expression itself produces, if any -- see
   * `ResultSpec`. Omitted means "not yet catalogued" (treat as
   * `{ kind: "none" }`), same discipline as an omitted `dataTypes`. */
  result?: ResultSpec;
  /** Which programming language(s) this call shape is legal in -- omitted
   * (the default for nearly every entry) means "confirmed or assumed
   * multi-language, no separate per-language shape needed" (e.g. `Coil`,
   * `P_Contact`, `#instance.TP(...)` all compile the same way whether the
   * owning NETWORK's `S7_Language` is "FBD" or "LAD"). Set this ONLY when
   * a name is confirmed exclusive to one language (e.g. `Contact`/
   * `I_Contact`/`Not` are LAD-only -- FBD has no equivalent box, it uses
   * `A`/`O`/`X` instead) -- see instruction-registry/README.md's
   * "Per-language instructions" section. Can also come from a YAML
   * file's own `$fileLanguage` key (loadRules.ts applies it as every
   * entry in that file's default unless the entry sets its own). */
  language?: InstructionLanguage[];
}

export type InstructionRegistry = Record<string, InstructionEntry>;

// --- type-registry -----------------------------------------------------

export interface NumberRepresentation {
  form: string; // boolean | binary | unsigned-integer | signed-integer | octal | hexadecimal | floating-point | character | string-literal | duration | date | time-of-day | date-time | pointer-literal
  min?: number;
  max?: number;
  range?: string;
  example?: string;
}

export interface BaseTypeEntry {
  category: string;
  sizeBits: number | null;
  /** `true` for a signed integer type (Int/DInt/...), `false` for unsigned
   * (UInt/UDInt/...), `null` for a non-integer category (Real, Bool,
   * Time, ...) where signedness doesn't apply. */
  signed: boolean | null;
  numberRepresentations?: NumberRepresentation[];
  [key: string]: unknown;
}
export type BaseTypeRegistry = Record<string, BaseTypeEntry>;

export interface SystemTypeMemberTypeRef {
  kind: "named" | "array" | "inline-struct";
  name?: string;
  bounds?: [number, number][];
  of?: SystemTypeMemberTypeRef;
  members?: { name: string; typeRef: SystemTypeMemberTypeRef }[];
}

export interface SystemTypeMember {
  name: string;
  type: SystemTypeMemberTypeRef;
  [key: string]: unknown;
}

export interface SystemTypeEntry {
  category: "system-struct" | "system-alias";
  basicDataType?: string; // system-alias only
  members?: SystemTypeMember[] | null; // system-struct only
  [key: string]: unknown;
}
export type SystemTypeRegistry = Record<string, SystemTypeEntry>;

export interface SectionLegality {
  allSections: { datatypes: string[] };
  sections: Record<string, { additionalDatatypes: string[] }>;
}

export interface CompositionRules {
  array: {
    dimensions: { min: number; max: number };
    index: { valueLimits: { min: number; max: number } };
    /** Legal VAR_* declaration sections for `ARRAY[*] of <type>` (dynamic
     * bounds), keyed by full block-type keyword -- a block type absent
     * from this map means ARRAY[*] isn't legal there at all (e.g.
     * ORGANIZATION_BLOCK), never guessed. */
    dynamicBounds?: { declarationSections: Record<string, string[]> };
  };
  struct: {
    maxNestingDepth: number;
    /** Machine-checkable form of `maxNestingDepthNote` -- see
     * composition-rules.yaml's own comment on `inOutSectionBonus` for why
     * that ONE field isn't currently enforced (needs per-block-interface
     * section context typeCache.ts's global per-UDT computation doesn't
     * have). */
    nestingDepthRules?: {
      baseLimit: number;
      extendedLimit: number;
      extendedLimitFirmwareGate: Record<string, string>;
      inOutSectionBonus: number;
      arrayOfStructOrUdtCost: number;
    };
    maxStructsPerDataBlock?: { limit: number; notes?: string };
  };
}

// --- type-registry: any-pointer.yaml / pointer-type.yaml / references.yaml /
// symbolic-runtime-access.yaml -- each loaded and typed only down to the
// fields a lint check actually reads; everything else (pure prose/
// narrative) passes through via the index signature rather than being
// fully modeled.

export interface AnyPointerRegistry {
  structure: {
    sizeBytes: number;
    zeroPointer: { literal: string; ladFbdLiteral: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  /** Keyed by the `B#16#xx`-style code -- `name` is the legacy/STL-style
   * type-code name legal in an ANY P#-literal's trailing `Type Number`
   * suffix (e.g. `P#M20.0 BYTE 10`). `NIL` names the null-pointer encoding,
   * not a selectable literal type -- callers exclude it explicitly rather
   * than this file omitting it, so the code table itself stays complete. */
  dataTypeCodes: Record<string, { name: string; description: string; platformOnly?: string }>;
  memoryAreaCodes: Record<string, { name: string; description: string; platformOnly?: string }>;
  [key: string]: unknown;
}

export interface PointerKind {
  name: string;
  description: string;
  /** Only the "Zero pointer" kind sets this (`"ZERO"`) -- absent for the
   * other three kinds. */
  zeroLiteral?: string;
  notes?: string;
}

export interface PointerTypeRegistry {
  structure: { sizeBytes: number; [key: string]: unknown };
  pointerKinds: PointerKind[];
  memoryAreaCodes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReferencesRegistry {
  declaration: {
    keyword: string;
    /** Full block-type keyword -> legal `.s7dcl` VAR_* section keywords --
     * a block type absent from this map means REF_TO isn't legal there
     * (e.g. DATA_BLOCK has no row), never guessed. */
    legalSections: Record<string, string[]>;
    /** Declaration CONTEXTS (as opposed to VAR_* sections above) where
     * REF_TO is always illegal -- `"STRUCT"` matches the parser's own
     * STRUCT-vs-VAR_* member-context distinction. */
    illegalContexts: string[];
    illegal: string[];
    [key: string]: unknown;
  };
  initialization: { default: string; [key: string]: unknown };
  comparison: { allowed: string; disallowed: string; [key: string]: unknown };
  /** Legal/illegal REF_TO target types -- `bitStrings.disallowed` is what
   * `analysis/documentIndex.ts`'s `checkReferenceTargetType` checks a
   * reference's dereferenced type against (currently just `[Bool]`). Only
   * this one sub-field is typed; the rest of `referenceableTargets` (and
   * everything else in this registry) stays under the top-level index
   * signature below until a check actually needs it. */
  referenceableTargets: { bitStrings: { allowed: string[]; disallowed: string[] }; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SymbolicRuntimeAccessRegistry {
  workflow: {
    matchingArrayBounds: { instruction: string; pins: string[]; notes?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CategoryIndex {
  categoriesByType: Record<string, { types: string[] }>;
  umbrellaLabels: Record<string, { categories: string[]; notes?: string }>;
}

export interface BcdFormatEntry {
  kind: string;
  notAValidDatatype: boolean;
  sizeBits: number;
  [key: string]: unknown;
}
export type BcdFormatRegistry = Record<string, BcdFormatEntry>;

// --- system-registry ----------------------------------------------------
// Mirrors system-registry/memory.yaml and system-registry/result.yaml --
// see LintServer/resources/system-registry for the canonical schema/data.

export interface MemoryAreaInfo {
  name: string;
  description: string;
  resolvedFrom: string[];
}

export interface DeclarationMappingEntry {
  /** Siemens' own instruction-doc operand-area column for this VAR_*
   * section (e.g. `Input`/`InOut`/`Temp` -> `L`) -- what a pin's
   * `memoryAreas` list is checked against, regardless of physical storage. */
  tiaDocOperandArea: string;
  physicalStorageByBlock: Record<string, string>;
}

export interface OperandResolution {
  absolutePrefixes: Record<string, string>;
  symbolicKinds: Record<string, string>;
  peripheralSuffix: { suffix: string; area: string; validBaseAreas: string[] };
}

export interface MemoryAreaRegistry {
  memoryAreas: Record<string, MemoryAreaInfo>;
  declarationMapping: Record<string, DeclarationMappingEntry>;
  operandResolution: OperandResolution;
  matching: { precedence: string[]; example?: unknown };
}

export interface ResultKindSpec {
  description: string;
  requiredKeys: string[];
  optionalKeys?: string[];
  forbiddenKeys?: string[];
  defaults?: { usage?: ResultUsage; transform?: string };
  constraints?: Record<string, string>;
}

/** The schema `result.yaml` itself documents (per-kind required/forbidden
 * keys and defaults) -- loaded so a lint check can read e.g. a kind's
 * default `usage.storable` instead of hardcoding it, matching the rest of
 * this codebase's "the YAML is the source of truth" discipline. */
export interface ResultSchema {
  schemaVersion: number;
  resultKinds: Record<string, ResultKindSpec>;
  inferenceRules: Record<string, { sourcePinCount: { min: number; max?: number }; description: string; requiresInstructionResolver?: boolean }>;
  transforms: Record<string, { description: string }>;
  usageContexts: Record<string, { description: string }>;
  validationOrder: string[];
}

export interface SystemRegistry {
  memory: MemoryAreaRegistry;
  result: ResultSchema;
}

// --- diagnostic-registry ------------------------------------------------
// Mirrors resources/diagnostic-registry/*.yaml -- every LintDiagnostic
// `code`/`severity`/`message` the linter can emit, as data instead of a
// hardcoded literal at each call site. See linter/diagnostics.ts
// (formatDiagnostic) for how a check turns one of these into a real
// LintDiagnostic, and resources/diagnostic-registry/README.md for the
// schema and the "why variants" rationale.

/** Canonical definition -- linter/diagnostics.ts (which owns LintDiagnostic
 * itself) imports and re-exports this rather than redeclaring it, so
 * rules/types.ts stays the single source of truth for the three severity
 * levels without rules/ depending on linter/. */
export type LintSeverity = "error" | "warning" | "information";

export interface DiagnosticSpec {
  /** Default severity for this code. A handful of checks compute severity
   * dynamically at runtime instead (e.g. downgraded to "warning" when the
   * triggering instruction-registry entry is only `confidence:
   * shape-only`) -- that's a fact from a DIFFERENT registry, so
   * formatDiagnostic's `severity` override wins over this default rather
   * than this file trying to encode it. */
  severity: LintSeverity;
  /** `{name}`-style placeholder template, filled in by formatDiagnostic
   * from the params the calling check passes. Every placeholder in the
   * template must have a matching param at call time (or it's a bug in
   * the check, not "don't guess" territory -- these are internal fill-ins,
   * not user-facing data that might be missing). Omit when EVERY use of
   * this code needs a different template -- see `variants` below. */
  message?: string;
  /** Named alternate templates for a code whose prose genuinely differs by
   * call site (e.g. "assigned from" vs. "used as an argument") rather than
   * by a filled-in param -- see resources/diagnostic-registry/README.md's
   * "Variants vs. params" section for the line between the two. */
  variants?: Record<string, string>;
  /** Maintainer-facing only -- not read by formatDiagnostic. */
  notes?: string;
}

/** Keyed by the exact string a LintDiagnostic's own `code` field uses. */
export type DiagnosticRegistry = Record<string, DiagnosticSpec>;

export interface RuleSet {
  instructions: InstructionRegistry;
  /** FULL standalone SCL-cased instruction entries, loaded from
   * `*-SCL.yaml` sibling files (e.g. `04-timers-SCL.yaml`) -- kept in a
   * SEPARATE map from `instructions` on purpose, since an SCL-cased `TP`
   * entry (uppercase `IN`/`PT`/`Q`/`ET` pins, every FBD-implicit pin made
   * explicit) would otherwise silently overwrite `04-timers.yaml`'s own
   * FBD-cased `TP` entry in one shared map. `linter/sclInstructionChecks.ts`
   * checks this map FIRST, falling back to `instructions` for any
   * instruction that doesn't (yet) have a dedicated SCL entry -- see
   * instruction-registry/README.md's "SCL as a third language" section. */
  sclInstructions: InstructionRegistry;
  baseTypes: BaseTypeRegistry;
  systemTypes: SystemTypeRegistry;
  sectionLegality: SectionLegality;
  composition: CompositionRules;
  categoryIndex: CategoryIndex;
  /** BCD16/BCD32 -- NOT valid VAR/STRUCT Datatypes (bcd-formats.yaml), only
   * meaningful as an `S7_Templates` value for a conversion instruction. */
  bcdFormats: BcdFormatRegistry;
  /** Names legal in a VAR_* section (per section-legality.yaml) that have
   * no base-types.yaml or system-types.yaml entry -- seeded into the type
   * cache as "opaque" per udt-dependency-cache.md's step 1b. */
  opaqueSectionNames: Set<string>;
  /** system-registry/{memory,result}.yaml -- pin memory-area/declaration
   * resolution rules and the `result` field's own schema (including each
   * kind's defaults). See linter/sclInstructionChecks.ts for the checks
   * built on top of these. */
  systemRegistry: SystemRegistry;
  anyPointer: AnyPointerRegistry;
  pointerType: PointerTypeRegistry;
  references: ReferencesRegistry;
  symbolicRuntimeAccess: SymbolicRuntimeAccessRegistry;
  /** type-registry/expression-operators.yaml -- domain-compatibility rules
   * for SCL binary expression operators, read by linter/exprTypeChecks.ts. */
  exprOperators: ExpressionOperatorRules;
  /** resources/diagnostic-registry/*.yaml -- every LintDiagnostic code's
   * severity/message, read by linter/diagnostics.ts's formatDiagnostic. */
  diagnostics: DiagnosticRegistry;
}

/** Mirrors type-registry/expression-operators.yaml -- see that file's own
 * header for what a "domain" is and why it's coarser than a
 * base-types.yaml `category`. */
export interface ExpressionOperatorDomainRule {
  operators: string[];
  allowedDomainPairs: [string, string][];
  warnOnMismatchWithinDomain?: string[];
  requireExactTypeMatch?: string[];
}

export interface ExpressionOperatorRules {
  categoryToDomain: Record<string, string>;
  arithmetic: ExpressionOperatorDomainRule;
  logical: ExpressionOperatorDomainRule;
  comparison: ExpressionOperatorDomainRule;
}
