// Builds a flat list of classified identifier "spans" for one open .s7dcl
// document: what kind of thing each identifier is (variable declaration,
// type, instruction call, pin, pragma key, wire label, literal...), plus
// optional hover markdown and a jump-to-definition target. This is the one
// pass that a SemanticTokensProvider, HoverProvider, and DefinitionProvider
// all share -- see providers/*.ts -- so highlighting, hover, and ctrl-click
// stay in lockstep with the same yaml-backed RuleSet + workspace BlockIndex
// instead of three independently-drifting implementations.
import { formatDiagnostic, LintDiagnostic, LintSeverity } from "../linter/diagnostics";
import { lookupType, TypeCacheResult } from "../cache/typeCache";
import { Lexer, Token, TokenCursor } from "../parser/lexer";
import { literalRunLength, tokensAdjacent } from "../parser/literalRun";
import { SCL_RESERVED_KEYWORDS } from "../parser/s7dclParser";
import { loadSiblingS7Res, MLC_ID_PRAGMA_KEYS, resolveMlcText, siblingS7ResPath, S7ResEntry } from "../parser/s7resParser";
import { TypeRef, typeRefDereferencedTopLevelName, typeRefToText, typeRefTopLevelName } from "../parser/typeRef";
import { anyDataTypeCodeNames, classifyLiteral, detectLiteralShape, expandPinDataTypes, resolveTypeAlias } from "../rules/literalTypes";
import { BaseTypeEntry, InstructionEntry, InstructionPin, RuleSet, SystemTypeEntry, SystemTypeMemberTypeRef } from "../rules/types";
import { BlockIndex, BlockInfo, GlobalTagInfo } from "./blockIndex";
import {
  calculateStandardMemberLayout,
  calculateStandardUdtLayout,
  isStandardTypeLayout,
  TypeLayoutResult,
} from "./typeLayout";

/** Semantic families for elementary datatype occurrences. Keys include the
 * canonical base-types.yaml names and the aliases users can write in SCL.
 * Keep this explicit: these are editor-facing conceptual groups, not a
 * one-to-one rendering of the registry's validation categories. */
const BUILTIN_TYPE_SEMANTICS: Readonly<Record<string, string>> = {
  s5time: "s7TemporalType",
  time: "s7TemporalType",
  ltime: "s7TemporalType",
  date: "s7TemporalType",
  time_of_day: "s7TemporalType",
  tod: "s7TemporalType",
  ltime_of_day: "s7TemporalType",
  ltod: "s7TemporalType",
  ldt: "s7TemporalType",
  date_and_time: "s7TemporalType",
  dt: "s7TemporalType",
  dtl: "s7TemporalType",

  usint: "s7IntegerType",
  uint: "s7IntegerType",
  udint: "s7IntegerType",
  ulint: "s7IntegerType",
  sint: "s7IntegerType",
  int: "s7IntegerType",
  dint: "s7IntegerType",
  lint: "s7IntegerType",
  byte: "s7IntegerType",
  word: "s7IntegerType",
  dword: "s7IntegerType",
  lword: "s7IntegerType",

  bool: "s7BooleanType",

  real: "s7FloatType",
  lreal: "s7FloatType",

  void: "s7GenericType",
  variant: "s7GenericType",
  any: "s7GenericType",
  pointer: "s7GenericType",
  reference: "s7GenericType",
  ref_to: "s7GenericType",
  array: "s7GenericType",

  string: "s7TextType",
  wstring: "s7TextType",
  char: "s7TextType",
  wchar: "s7TextType",
};

export interface Location {
  /** Absolute fs path of another file; omitted means "this document". */
  file?: string;
  line: number; // 1-based
  col?: number; // 1-based
}

export interface IdentifierSpan {
  line: number; // 1-based
  startCol: number; // 1-based
  length: number;
  tokenType: string;
  tokenModifiers: string[];
  hoverMarkdown?: string;
  definition?: Location;
  /** Always-visible inline annotation text (e.g. an S7_MLC id's resolved
   * comment) -- rendered as an editor decoration by providers/mlcHints.ts,
   * unlike hoverMarkdown which only shows on mouse-over. */
  inlineHint?: string;
  /** Stable identity key for providers/rename.ts: every span referring to
   * the SAME symbol (a declaration and all its references) carries the
   * identical key, so rename just has to group-by-key instead of
   * re-deriving resolution logic. Three shapes:
   *   `local:<docPath>:<name>`   -- doc-scoped (a VAR_TEMP/VAR/VAR_CONSTANT
   *                                 member, an OB's own vars, or a call's
   *                                 instance tag) -- renaming only touches
   *                                 THIS file.
   *   `member:<blockName>:<name>` -- an FB/FC's VAR_INPUT/VAR_OUTPUT/
   *                                 VAR_IN_OUT pin, or a DATA_BLOCK's own
   *                                 member -- externally reachable via
   *                                 `#instance.name`/named-pin syntax from
   *                                 OTHER files, so renaming is
   *                                 workspace-wide.
   *   `type:<blockName>`          -- a FUNCTION_BLOCK/FUNCTION/
   *                                 ORGANIZATION_BLOCK/DATA_BLOCK's own
   *                                 declared name -- workspace-wide.
   *   `udt:<typeName>`            -- a PLC data type's own TYPE declaration
   *                                 and every resolved reference to it --
   *                                 workspace-wide and case-insensitive via
   *                                 TypeCacheResult's canonical spelling.
   *   `mlc:<id>\0<s7resPath>`     -- an S7_MLC-family pragma's ID --
   *                                 renaming touches this doc's pragma
   *                                 value(s) AND the sibling `.s7res`. A
   *                                 `\0` separator (not `:`) because a
   *                                 Windows absolute path itself contains
   *                                 `:` (`D:\...`). */
  renameKey?: string;
}


export interface DocumentIndex {
  spans: IdentifierSpan[];
  diagnostics: LintDiagnostic[];
  /** Every VAR-section declaration seen in this document, keyed by name
   * (no leading `#`) -- exposed so providers/completion.ts can resolve a
   * `#tag` chain's type without re-implementing the VAR-section walk.
   *
   * ACCUMULATED across every declaration in the file, so two blocks
   * declaring the same name collide here (last one walked wins). Anything
   * deciding what is IN SCOPE at a position must use `blockScopes` instead
   * -- a tag is only addressable inside the block that declares it. */
  localDecls: Map<string, LocalDecl>;
  /** One entry per program-block declaration in the file, in file order --
   * what `localDecls` flattens away. See `BlockScope`. */
  blockScopes: BlockScope[];
}

/** A single program block's own declaration scope. SCL has no lexical
 * scoping WITHIN a block, but it has hard scoping BETWEEN blocks: a tag is
 * addressable only inside the block that declares it, so an authored `.scl`
 * bundling several declarations in one file (the norm -- see the top-level
 * walk) needs the boundaries kept, not flattened. */
export interface BlockScope {
  /** The block's declared name, or null if the declaration is mid-typing. */
  name: string | null;
  /** FUNCTION_BLOCK | FUNCTION | ORGANIZATION_BLOCK | DATA_BLOCK. */
  blockType: string;
  /** 1-based line of the block keyword. */
  startLine: number;
  /** 1-based line of the matching `END_xxx`, or the file's last line for a
   * declaration that isn't closed yet (mid-edit). */
  endLine: number;
  /** This block's own VAR_*-section declarations, keyed LOWER-CASE (SCL
   * identifiers are case-insensitive). A STRUCT/UDT field is deliberately
   * excluded -- it's reachable as `#owner.field`, never as a base tag of
   * its own. */
  decls: Map<string, LocalDecl>;
}

export interface LocalDecl {
  name: string;
  /** The type's ultimate named leaf (drilling through Array[...] of ...),
   * used to cross-reference the workspace BlockIndex -- null for an inline
   * STRUCT, which has no single name to resolve. */
  leafName: string | null;
  /** The type's OWN top-level name, WITHOUT drilling through Array (see
   * typeRefTopLevelName) -- used to check this operand against an
   * instruction pin's `dataTypes`, which describes the OPERAND'S type
   * (Array included), not its element type. */
  topLevelName: string | null;
  /** When `topLevelName === "Reference"` (a `REF_TO <X>` declaration), the
   * top-level name of `X` -- what `#tag^` (dereferenced) resolves to for
   * pin-type-checking purposes. `null` otherwise. */
  derefTopLevelName: string | null;
  /** When `topLevelName === "Array"`, the declared per-dimension bounds
   * (composition-rules.yaml order) -- used to range-check a literal
   * `#tag[i]` index. `null` for a non-array or a dynamic-bounds `ARRAY[*]`. */
  arrayBounds: [number, number][] | null;
  /** When `topLevelName === "Array"`, the element type's own top-level
   * name (Array's `topLevelName`, not drilled further) -- what `#tag[i]`
   * resolves to for pin-type-checking purposes. `null` otherwise. */
  elementTopLevelName: string | null;
  /** Same idea as `elementTopLevelName` but drilled through to the
   * ultimate named leaf, for cross-referencing the workspace BlockIndex
   * (e.g. `Array[0..3] of _.FB_MotorProtection` -> "FB_MotorProtection"). */
  elementLeafName: string | null;
  typeText: string;
  /** Exact parsed type shape retained for semantic capabilities and nested
   * inline-STRUCT/UDT member traversal. */
  typeRef: TypeRef;
  line: number;
  col: number;
  /** The VAR_* section keyword this was declared under ("STRUCT" for a
   * STRUCT/UDT field) -- used to decide this name's `renameKey` scope: an
   * FB/FC's VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT (or any DATA_BLOCK member) is
   * externally reachable from other files, everything else is doc-local. */
  section: string;
  /** For an INLINE `STRUCT ... END_STRUCT` declaration, its own fields (in
   * declaration order, recursively) -- there's no named type to look this
   * up from afterwards (`leafName` is null), so the members are captured
   * here as the walk passes them. `undefined` for every other type.
   * Consumed by providers/completion.ts's `#tag.`/`tag.` member list. */
  structMembers?: LocalDecl[];
  /** Span created for the declaration name before its type is walked. */
  declarationSpanIndex?: number;
}

const VAR_SECTION_KEYWORDS = ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP", "VAR_CONSTANT", "VAR"];
const BLOCK_KEYWORDS = ["FUNCTION_BLOCK", "FUNCTION", "ORGANIZATION_BLOCK", "DATA_BLOCK"];

const PRAGMA_DOCS: Record<string, string> = {
  S7_MLC: "Multilingual-comment ID for this declaration's comment text (resolved via TIA's text list, not stored inline).",
  S7_Templates: "Type-template pragma consumed by the lint server's template-shape check (see instruction-registry/README.md).",
  S7_GenerateENO: "Forces ENO generation on the following instruction call.",
  S7_Language: "Programming language of the following NETWORK/RUNG body (e.g. FBD).",
  S7_NetworkTitle: "Multilingual-comment ID for this NETWORK's title.",
  S7_NetworkComment: "Multilingual-comment ID for this NETWORK's comment text.",
  S7_BlockComment: "Multilingual-comment ID for the block's comment text.",
  S7_BlockTitle: "Multilingual-comment ID for the block's title.",
  S7_Optimized: "Whether the block uses optimized (symbolic) memory access.",
  S7_PreferredLanguage: "Default editor language for this block.",
  S7_Version: "Export format version.",
  S7_Setpoint: "Marks a tag as an operator setpoint value.",
};

function pragmaHover(key: string): string {
  const doc = PRAGMA_DOCS[key];
  return `**${key}** _(pragma)_${doc ? `\n\n${doc}` : ""}`;
}

/** `isScl` only changes the pin-table header's own wording ("pin" ->
 * "parameter", SCL has no "pin" concept) -- everything else (dir/required/
 * types) already reads correctly for SCL once the caller has resolved the
 * entry via `findSclInstruction` (which fixes up `required` per-source, see
 * that function's own comment), so there's no need to touch those columns. */
export function renderInstructionHover(name: string, entry: InstructionEntry, isScl = false): string {
  const lines: string[] = [`**${name}** _(${entry.family}${entry.callShape !== "box" ? `, ${entry.callShape}` : ""})_`];
  if (entry.language && entry.language.length > 0) lines.push(`${entry.language.join("/")}-only`);
  if (entry.instanceType) lines.push(`instance type: \`${entry.instanceType}\``);
  lines.push("");
  if (entry.pins.length > 0) {
    lines.push(isScl ? "| parameter | dir | required | types |" : "| pin | dir | required | types |", "|---|---|---|---|");
    for (const p of entry.pins) {
      const types = p.dataTypes && p.dataTypes.length > 0 ? p.dataTypes.join(", ") : p.containerKinds ? `(${p.containerKinds.join("/")} element)` : "—";
      lines.push(`| ${p.name ?? "_(positional)_"} | ${p.dir === "in" ? ":=" : "=>"} | ${p.required ? "yes" : "no"} | ${types} |`);
    }
    lines.push("");
  }
  if (entry.template && entry.template.shape !== "none") {
    lines.push(`requires \`S7_Templates\` — ${entry.template.shape} [${entry.template.keys.join(", ")}]`, "");
  }
  if (entry.enEno) {
    const side = (label: string, s: typeof entry.enEno.en) => {
      if (!s) return `${label}: unconfirmed`;
      if (!s.present) return `${label}: none`;
      const areas = Object.entries(s.memoryArea ?? {})
        .filter(([, v]) => v.length > 0)
        .map(([platform, v]) => `${platform} ${v.join("/")}`)
        .join(", ");
      return `${label}${areas ? ` (${areas})` : ""}`;
    };
    lines.push(`${side("EN", entry.enEno.en)} · ${side("ENO", entry.enEno.eno)}`, "");
  }
  if (entry.confidence === "shape-only") lines.push("_shape-only entry — pin arity confirmed from a blank-pin export; types/ENO not yet verified against real docs_", "");
  if (entry.notes) lines.push(entry.notes);
  if (entry.source) lines.push("", `source: ${entry.source}`);
  return lines.join("\n");
}

function renderMemberTypeRef(ref: SystemTypeMemberTypeRef): string {
  if (ref.kind === "named") return ref.name ?? "?";
  if (ref.kind === "array") {
    const bounds = (ref.bounds ?? []).map(([lo, hi]) => `${lo}..${hi}`).join(", ");
    return `Array[${bounds}] of ${ref.of ? renderMemberTypeRef(ref.of) : "?"}`;
  }
  return "STRUCT";
}

/** Parses an ARRAY declaration's raw bounds tokens (between `[` and `]`)
 * into `[lo, hi][]` per dimension, or `null` for a dynamic `ARRAY[*]` or
 * anything not cleanly `num..num[, num..num...]` (a symbolic/constant
 * bound -- don't guess). Companion to `checkArrayDeclaration`, which
 * validates the same tokens; kept separate since this one needs to run
 * even when validation passes, to remember the bounds for later
 * `#tag[i]` index range-checks. */
function parseBoundsGroups(boundsTokens: Token[]): [number, number][] | null {
  if (boundsTokens.length === 1 && boundsTokens[0].kind === "punct" && boundsTokens[0].text === "*") return null;
  const groups: Token[][] = [[]];
  for (const t of boundsTokens) {
    if (t.kind === "punct" && t.text === ",") groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  const bounds: [number, number][] = [];
  for (const g of groups) {
    if (g.length !== 4) return null;
    const [numLo, dot1, dot2, numHi] = g;
    if (numLo.kind !== "number" || dot1.text !== "." || dot2.text !== "." || numHi.kind !== "number") return null;
    bounds.push([parseInt(numLo.text, 10), parseInt(numHi.text, 10)]);
  }
  return bounds;
}

function renderBaseTypeHover(name: string, entry: BaseTypeEntry): string {
  const lines = [`**${name}** _(elementary type — ${entry.category})_`];
  if (entry.sizeBits != null) lines.push(`size: ${entry.sizeBits} bit(s)`);
  const notes = typeof entry.notes === "string" ? entry.notes : undefined;
  if (notes) lines.push("", notes);
  return lines.join("  \n");
}

function renderSystemTypeHover(name: string, entry: SystemTypeEntry): string {
  const lines = [`**${name}** _(system ${entry.category === "system-struct" ? "struct" : "alias"})_`];
  if (entry.category === "system-alias" && entry.basicDataType) lines.push(`underlying type: \`${entry.basicDataType}\``);
  if (entry.category === "system-struct" && entry.members) {
    lines.push("", "| member | type |", "|---|---|");
    for (const m of entry.members) lines.push(`| ${m.name} | ${renderMemberTypeRef(m.type)} |`);
  }
  return lines.join("\n");
}

function formatStorageBits(bits: number): string {
  if (bits % 8 === 0) {
    const bytes = bits / 8;
    return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  }
  return `${bits} bit${bits === 1 ? "" : "s"}`;
}

/** Finds the `]` matching a `[` at lookahead offset `openIdx` (i.e.
 * `cur.peek(openIdx)` must itself be that `[`), handling nested brackets.
 * Returns the matching `]`'s own lookahead offset, or `null` if unbalanced
 * or the scan runs past a generous bound (a malformed/huge index
 * expression isn't worth scanning further for a mere lookahead). Used by
 * `tryWalkCall` to see past a `#arr[i]` of unknown length before deciding
 * whether `.Instruction(` follows (an array-of-instance call). */
function findMatchingBracketClose(cur: TokenCursor, openIdx: number): number | null {
  let depth = 0;
  for (let i = openIdx; i < openIdx + 40; i++) {
    const t = cur.peek(i);
    if (t.kind === "eof") return null;
    if (t.kind === "punct" && t.text === "[") depth++;
    if (t.kind === "punct" && t.text === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Looks ahead (without consuming) for a contiguous run of tokens that
 * together form a typed/radix literal the lexer had to split up -- see
 * parser/literalRun.ts for the shape and the Siemens grammar behind it.
 * `TRUE`/`FALSE`/`NULL`/`ZERO` are excluded: `consumeLiteralValue` handles
 * those keywords itself, before it gets here. */
function scanLiteralRun(cur: TokenCursor): number {
  return literalRunLength(cur, 0, { pointerTail: true });
}

/** Looks ahead (without consuming) for an absolute/direct-address operand
 * (base-types.yaml's `addressExamples` shapes: `I1.0`, `MW10`,
 * `DB1.DBX2.3`, optionally `%`-prefixed) -- another case the lexer splits
 * across multiple tokens (`.` can't be part of an identifier). Returns the
 * token count, or 0 if the current position isn't the start of one. */
function scanAddressRun(cur: TokenCursor): number {
  let n = 0;
  let prev: Token = cur.peek(0);
  if (prev.kind === "punct" && prev.text === "%") n = 1;

  const head = cur.peek(n);
  if (n > 0 && !tokensAdjacent(prev, head)) return 0;
  if (head.kind !== "ident") return 0;
  prev = head;

  if (/^(I|Q|M)(B|W|D)\d+$/i.test(head.text)) return n + 1; // IB2, MW10, MD10, ...

  if (/^(I|Q|M)\d+$/i.test(head.text)) {
    const dot = cur.peek(n + 1);
    const bit = cur.peek(n + 2);
    if (tokensAdjacent(prev, dot) && dot.kind === "punct" && dot.text === "." && tokensAdjacent(dot, bit) && bit.kind === "number") {
      return n + 3; // I1.0, Q0.1, M50.7
    }
    return 0;
  }

  if (/^DB\d+$/i.test(head.text)) {
    const dot1 = cur.peek(n + 1);
    const sub = cur.peek(n + 2);
    if (!(tokensAdjacent(prev, dot1) && dot1.kind === "punct" && dot1.text === "." && tokensAdjacent(dot1, sub) && sub.kind === "ident")) return 0;
    if (/^DBX\d+$/i.test(sub.text)) {
      const dot2 = cur.peek(n + 3);
      const bit = cur.peek(n + 4);
      if (tokensAdjacent(sub, dot2) && dot2.kind === "punct" && dot2.text === "." && tokensAdjacent(dot2, bit) && bit.kind === "number") {
        return n + 5; // DB1.DBX2.3
      }
      return 0;
    }
    if (/^(DBB|DBW|DBD)\d+$/i.test(sub.text)) return n + 3; // DB1.DBB4, DB1.DBW2, DB1.DBD8
    return 0;
  }

  return 0;
}

/** Consumes and returns the literal value starting at `cur` -- a quoted
 * string/char, `TRUE`/`FALSE`/`NULL`/`ZERO`, an absolute address, or a
 * (possibly multi-token, see `scanLiteralRun`) numeric/typed literal --
 * or `null` if the current position isn't a literal at all (e.g. a `#tag`
 * or bare identifier). */
function consumeLiteralValue(cur: TokenCursor, ruleSet: RuleSet): { rawText: string; tok: Token; spanLength: number } | null {
  const t0 = cur.peek();
  if (t0.kind === "string") {
    cur.next();
    return { rawText: t0.text, tok: t0, spanLength: t0.text.length };
  }
  if (/^(TRUE|FALSE|NULL|ZERO)$/i.test(t0.text) && t0.kind === "ident") {
    cur.next();
    return { rawText: t0.text, tok: t0, spanLength: t0.text.length };
  }
  const addrLen = scanAddressRun(cur);
  if (addrLen > 0) {
    const startTok = cur.peek();
    const parts: string[] = [];
    for (let i = 0; i < addrLen; i++) parts.push(cur.next().text);
    const rawText = parts.join("");
    return { rawText, tok: startTok, spanLength: rawText.length };
  }
  const runLen = scanLiteralRun(cur);
  if (runLen > 0) {
    const startTok = cur.peek();
    const parts: string[] = [];
    for (let i = 0; i < runLen; i++) parts.push(cur.next().text);
    let rawText = parts.join("");
    let spanLength = rawText.length;
    // Any's P#-literal grammar always carries a trailing `Type Number`
    // pair (e.g. `P#M20.0 BYTE 10`, spaces and all) that Pointer's never
    // has -- see any-pointer.yaml/pointer-type.yaml and classifyLiteral's
    // own P# handling, which this reconstructed text feeds into. Gated on
    // a recognized type-code name so an unrelated `P#tag), NextPin := ...`
    // sequence is never mistakenly swallowed. spanLength is measured off
    // real source offsets (not the reconstructed text's single space)
    // since actual whitespace between address/type/number may differ.
    if (/^P#/i.test(rawText)) {
      const typeTok = cur.peek();
      const numTok = cur.peek(1);
      if (typeTok.kind === "ident" && anyDataTypeCodeNames(ruleSet).has(typeTok.text.toUpperCase()) && numTok.kind === "number") {
        cur.next();
        cur.next();
        rawText += ` ${typeTok.text} ${numTok.text}`;
        spanLength = numTok.offset + numTok.text.length - startTok.offset;
      }
    }
    return { rawText, tok: startTok, spanLength };
  }
  return null;
}


/** Dot-accessible members of a timer/counter instance that AREN'T modeled
 * as named `pins` entries in instruction-registry -- they're positionally
 * implicit in a box CALL (the rung's leading condition, or "whatever
 * follows the box"), but still real, documented, readable struct fields
 * outside of one (e.g. `#tonX.Q`, per 04-timers.yaml's own note: "status
 * ... can only be read by a separate dot-access query elsewhere, e.g.
 * \"DB1\".MyIEC_TIMER.Q"). Keyed by INSTRUCTION name (not instanceType),
 * confirmed per-instruction from each entry's own `notes` field. */
export const IMPLICIT_INSTANCE_MEMBERS: Record<string, { name: string; dataTypes: string[] }[]> = {
  TP: [
    { name: "IN", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] },
  ],
  TON: [
    { name: "IN", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] },
  ],
  TOF: [
    { name: "IN", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] },
  ],
  TONR: [
    { name: "IN", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] },
  ],
  CTU: [
    { name: "CU", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] }, // TRUE iff CV >= PV
  ],
  CTD: [
    { name: "CD", dataTypes: ["Bool"] },
    { name: "Q", dataTypes: ["Bool"] }, // TRUE iff CV <= 0
  ],
  CTUD: [
    { name: "CU", dataTypes: ["Bool"] },
    { name: "QU", dataTypes: ["Bool"] }, // TRUE iff CV >= PV; QD is already a named pin
  ],
};

/** 03-counters.yaml: `instanceType` encodes the counted value type in its
 * own suffix (CTU_INT, CTU_DINT, ...) -- resolving THAT suffix gives a
 * concrete type for pv/cv/etc, tighter than the umbrella "Integers" those
 * pins list generically (which also covers Char/WChar/Date). */
const COUNTER_SUFFIX_TYPES: Record<string, string> = {
  SINT: "SInt",
  USINT: "USInt",
  INT: "Int",
  UINT: "UInt",
  DINT: "DInt",
  UDINT: "UDInt",
  LINT: "LInt",
  ULINT: "ULInt",
};

/** The `ruleSet.instructions` key matching `name`, ignoring case -- SCL
 * instruction names are case-insensitive (`ton`/`TON`), same as every other
 * identifier in the language. */
function findInstructionCaseInsensitive(ruleSet: RuleSet, name: string): string | undefined {
  if (ruleSet.instructions[name]) return name;
  const lower = name.toLowerCase();
  return Object.keys(ruleSet.instructions).find((k) => k.toLowerCase() === lower);
}

function refineCounterValueTypes(instanceTypeName: string, dataTypes: string[]): string[] {
  const m = /^(?:CTU|CTD|CTUD)_(.+)$/i.exec(instanceTypeName);
  if (!m) return dataTypes;
  const concrete = COUNTER_SUFFIX_TYPES[m[1].toUpperCase()];
  if (!concrete || !dataTypes.includes("Integers")) return dataTypes;
  return dataTypes.map((dt) => (dt === "Integers" ? concrete : dt));
}

/** Reverse index from an instance-dot instruction's `instanceType` (e.g.
 * `TON_TIME`) to the instruction name(s) declaring it (e.g. `TON`) -- an
 * SCL `#instanceName(...)` bare-instance call (linter/sclInstructionChecks.ts)
 * and a LAD/FBD `#instanceName.XXX` dot-completion (`listInstanceMembers`
 * below) both need to resolve a declared VAR type back to the instruction(s)
 * it calls, since the registry is keyed by instruction NAME, not by
 * instanceType. Falls back to the CTU/CTD/CTUD family prefix match for the
 * counter family's per-counted-type instance names (`CTU_DINT`, `CTU_REAL`,
 * ...), which the registry only lists once under the generic `CTU_INT`
 * placeholder (see 03-counters.yaml's own header). */
export function resolveInstanceTypeToInstructionNames(ruleSet: RuleSet, instanceTypeName: string): string[] {
  const instanceTypeToInstructions = new Map<string, string[]>();
  // Hand-authored SCL declares a timer/edge instance by the INSTRUCTION
  // name (`HB_Timer : TON;`) -- it's a TIA export that rewrites the same
  // declaration to the `instanceType` (`TON_TIME`). Both spellings name the
  // same instance, so the instruction's own name is a valid key too;
  // without it, `#HB_Timer.Q`/`HB_Timer.Q` resolved to nothing at all.
  const identity = findInstructionCaseInsensitive(ruleSet, instanceTypeName);
  if (identity && ruleSet.instructions[identity].callShape === "instance-dot") return [identity];
  for (const [name, entry] of Object.entries(ruleSet.instructions)) {
    // Only "instance-dot" instructions' pins become the INSTANCE's own
    // dot-accessible fields (`#tonX.ET`) -- a "coil-ref" instruction like
    // TON_Coil also names TON_TIME as its `instanceType`, but its pins
    // (e.g. `timer`) merely take a REFERENCE to a TON_TIME instance as an
    // argument; they aren't members of the instance itself, and listing
    // them here would offer nonsense completions like `#tonX.timer`.
    if (entry.instanceType && entry.callShape === "instance-dot") {
      const list = instanceTypeToInstructions.get(entry.instanceType) ?? [];
      list.push(name);
      instanceTypeToInstructions.set(entry.instanceType, list);
    }
  }
  let instrNames = instanceTypeToInstructions.get(instanceTypeName) ?? [];
  if (instrNames.length === 0) {
    const lower = instanceTypeName.toLowerCase();
    for (const [key, names] of instanceTypeToInstructions) {
      if (key.toLowerCase() === lower) {
        instrNames = names;
        break;
      }
    }
  }
  if (instrNames.length === 0) {
    const m = /^(CTU|CTD|CTUD)_/i.exec(instanceTypeName);
    if (m && ruleSet.instructions[m[1].toUpperCase()]) instrNames = [m[1].toUpperCase()];
  }
  return instrNames;
}

/** Whether a `.member` DOT-NOTATION READ into a `blockType` block's own
 * `section` member is legal at all -- a genuinely different question from
 * this file's own (nested, nameless-adjacent) `isExternallyReachable`
 * helper inside `buildDocumentIndex`, which decides whether a member's NAME
 * needs to be renamed across files (true for a FUNCTION's own
 * VAR_INPUT/VAR_OUTPUT too, since another file's call site still names
 * that parameter, e.g. `TestFun(x := 5)`). Dot-access is different: a
 * `FUNCTION` has no instance data whatsoever, so `"TestFun".x` (or
 * `#someTag.x` if `someTag` somehow named a FUNCTION) is NEVER legal
 * regardless of section -- unlike a FUNCTION_BLOCK's own instance data,
 * where VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT/VAR (STATIC) are all legally
 * dot-readable but VAR_TEMP/VAR_CONSTANT are not, and a DATA_BLOCK (pure
 * static data, no TEMP/CONST distinction the same way) exposes everything
 * except an inline STRUCT pseudo-section. Exported for
 * `analysis/symbolTable.ts`'s `resolveMember`/`resolveOperandRef`, which
 * enforce this for BOTH a local `#instance.member` and an external
 * `"Name".member` reference -- see `linter/symbolChecks.ts`'s
 * `checkIllegalDotAccess`. */
export function isDotAccessLegal(blockType: string | null, section: string): boolean {
  if (blockType === "DATA_BLOCK") return section !== "STRUCT";
  if (blockType === "FUNCTION_BLOCK") {
    return section === "VAR_INPUT" || section === "VAR_OUTPUT" || section === "VAR_IN_OUT" || section === "VAR";
  }
  return false; // FUNCTION (no instance data at all) / ORGANIZATION_BLOCK (never instantiated) / unknown
}

/** Lists EVERY dot-accessible member of a timer/counter/edge-detection
 * SYSTEM instance type (e.g. all of TON_TIME's: pt, et, IN, Q) -- the
 * completion-list counterpart to `resolveInstanceMember` (which finds one
 * specific name). Standalone/exported since providers/completion.ts needs
 * it outside `buildDocumentIndex`'s closure. */
/** `preferScl` picks the dedicated `*-SCL` registry entry when one exists, so
 * members are offered with SCL's own parameter spelling (`CLK`/`Q`) rather
 * than the graphical entry's (`clk`/`q`). Off by default -- a LAD/FBD context
 * wants the graphical names -- and passed only where the syntax is SCL-only,
 * e.g. a quoted instance-DB reference (`"R_TRIG_DB".Q`), which has no
 * graphical equivalent. Falls back to the graphical entry when the SCL map
 * has no entry for that instruction. */
export function listInstanceMembers(
  ruleSet: RuleSet,
  instanceTypeName: string,
  preferScl = false
): { name: string; dataTypes: string[]; source: string }[] {
  const instrNames = resolveInstanceTypeToInstructionNames(ruleSet, instanceTypeName);

  const result: { name: string; dataTypes: string[]; source: string }[] = [];
  const seen = new Set<string>();
  for (const instrName of instrNames) {
    const entry = (preferScl ? ruleSet.sclInstructions[instrName] : undefined) ?? ruleSet.instructions[instrName];
    if (!entry) continue;
    for (const pin of entry.pins) {
      if (!pin.name || seen.has(pin.name.toLowerCase())) continue;
      seen.add(pin.name.toLowerCase());
      result.push({ name: pin.name, dataTypes: refineCounterValueTypes(instanceTypeName, pin.dataTypes ?? []), source: instrName });
    }
    for (const implicit of IMPLICIT_INSTANCE_MEMBERS[instrName] ?? []) {
      if (seen.has(implicit.name.toLowerCase())) continue;
      seen.add(implicit.name.toLowerCase());
      result.push({ name: implicit.name, dataTypes: implicit.dataTypes, source: instrName });
    }
  }
  return result;
}

/** `docPath` (this document's own fs path) is optional -- an unsaved/
 * untitled document has none, and MLC resolution just silently no-ops for
 * it (don't guess a `.s7res` sibling for a file that has no path yet).
 * `mlcLocale` is the user's configured preferred locale (tiaLint.mlcLocale,
 * default "en-US"); resolveMlcText applies its own en-US/first-available
 * fallback when the preferred locale isn't present for a given ID. */
export function buildDocumentIndex(
  text: string,
  ruleSet: RuleSet,
  blockIndex: BlockIndex,
  docPath?: string,
  mlcLocale: string = "en-US",
  typeCache?: TypeCacheResult
): DocumentIndex {
  const tokens = new Lexer(text).tokenize();
  const cur = new TokenCursor(tokens);
  const spans: IdentifierSpan[] = [];
  // `let`, not `const`: walkSclBody temporarily swaps this out for a
  // throwaway array while walking an SCL statement body -- see that
  // function's own comment for why.
  let diagnostics: LintDiagnostic[] = [];
  const localDecls = new Map<string, LocalDecl>();

  // Lazy + memoized: most documents have MANY MLC pragmas (one per
  // commented VAR member) but only ONE sibling `.s7res` file to read.
  let s7res: ReturnType<typeof loadSiblingS7Res> | null = null;
  let s7resLoaded = false;
  function getS7Res() {
    if (!s7resLoaded) {
      s7resLoaded = true;
      s7res = docPath ? loadSiblingS7Res(docPath) ?? null : null;
    }
    return s7res;
  }

  // Set once at the top-level walk (block keyword) / on entering each
  // VAR_* section -- read by checkReferenceLegality/checkArrayDeclaration
  // below, which need to know "which section, in which block type" a
  // REF_TO or ARRAY[*] declaration sits in to check it against
  // references.yaml/composition-rules.yaml's section-legality tables.
  let currentBlockType: string | null = null;
  let currentSectionKind: string | null = null;
  let currentBlockName: string | null = null;

  // Keep scalar/value types separate from Siemens object/runtime types. They
  // behave differently in SCL and should read differently in the editor, in
  // the same way a language distinguishes `int` from a framework class.
  // Both sets are lower-cased because SCL type names are case-insensitive.
  const primitiveTypeNames = new Set<string>();
  const baseTypesByLowerName = new Map<string, (typeof ruleSet.baseTypes)[string]>();
  const baseTypeCanonicalNames = new Map<string, string>();
  for (const [name, entry] of Object.entries(ruleSet.baseTypes)) {
    primitiveTypeNames.add(name.toLowerCase());
    baseTypesByLowerName.set(name.toLowerCase(), entry);
    baseTypeCanonicalNames.set(name.toLowerCase(), name);
    for (const alias of (entry as { aliases?: string[] }).aliases ?? []) {
      primitiveTypeNames.add(alias.toLowerCase());
      baseTypesByLowerName.set(alias.toLowerCase(), entry);
      baseTypeCanonicalNames.set(alias.toLowerCase(), name);
    }
  }
  const systemTypeNames = new Set<string>();
  const systemTypeCanonicalNames = new Map<string, string>();
  for (const name of Object.keys(ruleSet.systemTypes)) {
    systemTypeNames.add(name.toLowerCase());
    systemTypeCanonicalNames.set(name.toLowerCase(), name);
  }
  for (const name of ruleSet.opaqueSectionNames) systemTypeNames.add(name.toLowerCase());

  // True only while `walkSclBody` is walking a `BEGIN ... END_xxx` SCL
  // statement body. Gates the BARE (unprefixed, unquoted) local-tag
  // spelling TIA's external-source importer accepts -- see
  // parser/s7dclParser.ts's `LocalTagNames`. A LAD/FBD RUNG body is full of
  // bare identifiers that are NOT operands (instruction names, pin names),
  // so `walkRung` must keep treating them the old way.
  let inSclBody = false;

  // The block currently being walked and its own VAR-section declarations,
  // keyed lower-case -- reset per block, unlike `localDecls` (which
  // deliberately accumulates across a multi-declaration `.scl` file, see the
  // top-level walk). Only a tag THIS block declares is addressable at all,
  // which is what keeps a later block's `IF Enable THEN` from silently
  // resolving against an earlier block's `Enable`. Published as
  // `DocumentIndex.blockScopes` for providers/completion.ts.
  const blockScopes: BlockScope[] = [];
  let currentBlockTags = new Map<string, LocalDecl>();

  /** A declared local tag by name, case-insensitively -- SCL identifiers
   * are case-insensitive, only their declared spelling is preserved. */
  function findLocalDecl(name: string): LocalDecl | undefined {
    const exact = localDecls.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const decl of localDecls.values()) {
      if (decl.name.toLowerCase() === lower) return decl;
    }
    return undefined;
  }

  /** True when `name` is one of THIS block's declared tags addressable as a
   * bare base reference (the `#`-less spelling, SCL bodies only). */
  function isBareLocalTag(tok: Token): boolean {
    return inSclBody && tok.kind === "ident" && !tok.text.startsWith("#") && !SCL_RESERVED_KEYWORDS.has(tok.text.toUpperCase()) && currentBlockTags.has(tok.text.toLowerCase());
  }

  const S7_CAPABILITY_MODIFIERS = ["s7Container", "s7Indexable"] as const;

  function normalizedCapabilities(values: Iterable<string>): string[] {
    const present = new Set(values);
    return S7_CAPABILITY_MODIFIERS.filter((modifier) => present.has(modifier));
  }

  /** Capabilities of one named type. Unknown non-system names are treated as
   * UDT-shaped containers, matching typeNameSemantics's own s7UdtType
   * fallback. ARRAY's element-dependent container capability is added by the
   * TypeRef/LocalDecl helpers below. */
  function namedTypeCapabilities(name: string | null | undefined): string[] {
    if (!name) return [];
    const lower = name.toLowerCase();
    if (lower === "string" || lower === "wstring" || lower === "array") return ["s7Indexable"];
    if (lower === "struct") return ["s7Container"];

    const block = blockIndex.get(name);
    if (block?.blockType === "DATA_BLOCK" || block?.blockType === "FUNCTION_BLOCK") return ["s7Container"];
    if (resolveInstanceTypeToInstructionNames(ruleSet, name).length > 0) return ["s7Container"];

    const systemEntry = Object.entries(ruleSet.systemTypes).find(([candidate]) => candidate.toLowerCase() === lower)?.[1];
    if (systemEntry?.category === "system-struct" && systemEntry.members?.length) return ["s7Container"];

    // A known elementary/opaque/system handle has no dotted/indexed value
    // capability unless covered above. Anything still unresolved is exactly
    // what typeNameSemantics presents as a project UDT.
    if (primitiveTypeNames.has(lower) || systemTypeNames.has(lower)) return [];
    return ["s7Container"];
  }

  function typeRefCapabilities(ref: TypeRef | undefined): string[] {
    if (!ref) return [];
    if (ref.kind === "inline-struct") return ["s7Container"];
    if (ref.kind === "reference") return typeRefCapabilities(ref.of);
    if (ref.kind === "array") {
      const elementCapabilities = typeRefCapabilities(ref.of);
      return normalizedCapabilities([
        ...(elementCapabilities.includes("s7Container") ? ["s7Container"] : []),
        "s7Indexable",
      ]);
    }
    return namedTypeCapabilities(ref.name);
  }

  function localDeclCapabilities(decl: LocalDecl | undefined): string[] {
    return typeRefCapabilities(decl?.typeRef);
  }

  function blockValueCapabilities(block: BlockInfo | undefined): string[] {
    return block && (block.blockType === "DATA_BLOCK" || block.blockType === "FUNCTION_BLOCK") ? ["s7Container"] : [];
  }

  function cachedMemberType(ref: TypeRef | undefined, memberName: string): { typeRef: TypeRef; line?: number; file?: string } | undefined {
    if (!ref) return undefined;
    let members: { name: string; typeRef: TypeRef; line?: number }[] | undefined;
    let file: string | undefined;
    if (ref.kind === "inline-struct") {
      members = ref.members;
    } else if (ref.kind === "named" && typeCache) {
      const info = lookupType(typeCache, ref.name);
      if (info?.kind === "udt") {
        members = info.members;
        file = info.sourceFile;
      }
    }
    const member = members?.find((candidate) => candidate.name.toLowerCase() === memberName.toLowerCase());
    return member ? { typeRef: member.typeRef, line: member.line, file } : undefined;
  }

  function blockForTypeRef(ref: TypeRef | undefined): BlockInfo | undefined {
    return ref?.kind === "named" ? blockIndex.get(ref.name) : undefined;
  }

  /** Whether a declaration owns callable instance state: a workspace FB or
   * a Siemens timer/counter/edge instruction, directly or as an ARRAY
   * element. Kept separate from call-site classification: the object is an
   * `s7CallableInstance` in declarations/member access and a `function` only
   * where it is directly invoked. */
  function isCallableInstanceDecl(decl: LocalDecl | undefined): boolean {
    if (!decl) return false;
    const leaf = decl.elementLeafName ?? decl.leafName;
    if (leaf && blockIndex.get(leaf)?.blockType === "FUNCTION_BLOCK") return true;
    const top = decl.elementTopLevelName ?? decl.topLevelName;
    return Boolean(top && resolveInstanceTypeToInstructionNames(ruleSet, top).length > 0);
  }

  /** Semantic-token type for a declared local tag in NON-CALL contexts.
   * Callable objects get their S7-specific variable subtype; `tryWalkCall`
   * reclassifies the direct callee occurrence as `function`. A STRUCT/UDT or
   * DATA_BLOCK member is an object `property`; an FB/FC interface value is a
   * `parameter`; every other tag is a plain `variable`. */
  function localTagTokenType(decl: LocalDecl | undefined): string {
    if (!decl) return "variable";
    if (isCallableInstanceDecl(decl)) return "s7CallableInstance";
    if (decl.section === "STRUCT" || currentBlockType === "DATA_BLOCK") return "property";
    if (isInterfaceDecl(decl)) return "parameter";
    return "variable";
  }

  /** An FB/FC interface value keeps its parameter identity through nested
   * UDT/STRUCT access. The root itself is the standard `parameter`; resolved
   * scalar leaves use the `s7InterfaceMember` subtype while structural
   * members retain their container/indexable presentation. */
  function isInterfaceDecl(decl: LocalDecl | undefined): boolean {
    return Boolean(
      decl &&
      (currentBlockType === "FUNCTION" || currentBlockType === "FUNCTION_BLOCK") &&
      (decl.section === "VAR_INPUT" || decl.section === "VAR_OUTPUT" || decl.section === "VAR_IN_OUT")
    );
  }

  /** Whether a `section`-kind member of a `blockType` block is reachable
   * from OTHER files (via `#instance.name`/named-pin syntax) -- an FB/FC's
   * VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT, or any DATA_BLOCK member. Everything
   * else (VAR_TEMP/VAR/VAR_CONSTANT, an ORGANIZATION_BLOCK's own vars, a
   * STRUCT/UDT field) is doc-local -- OBs aren't instantiated by other
   * blocks, and a STRUCT/UDT field lives in the separate type-cache index
   * this pass doesn't share, so it's left un-renamed-across-files rather
   * than guessed at. */
  function isExternallyReachable(blockType: string | null, section: string): boolean {
    if (blockType === "DATA_BLOCK") return section !== "STRUCT";
    if (blockType === "FUNCTION_BLOCK" || blockType === "FUNCTION") {
      // Plain VAR (an FB's own STATIC data) is just as externally
      // dot-accessible/renameable as its VAR_INPUT/OUTPUT/IN_OUT pins --
      // see IdentifierSpan's own doc comment's `member:` key description.
      return section === "VAR_INPUT" || section === "VAR_OUTPUT" || section === "VAR_IN_OUT" || section === "VAR";
    }
    return false;
  }

  /** Decides a THIS-DOCUMENT declaration's `renameKey` (see IdentifierSpan's
   * own doc comment). `section` is a VAR_* keyword or "STRUCT" (see
   * LocalDecl.section). */
  function memberRenameKey(varName: string, section: string): string {
    if (currentBlockName !== null && isExternallyReachable(currentBlockType, section)) return `member:${currentBlockName}:${varName}`;
    return `local:${docPath ?? ""}:${varName}`;
  }

  /** references.yaml's declaration.illegal (never a STRUCT/UDT member) and
   * declaration.legalSections (block-type/section-dependent otherwise). */
  function checkReferenceLegality(tok: Token, memberContext: "VAR" | "STRUCT"): void {
    if (ruleSet.references.declaration.illegalContexts.includes(memberContext)) {
      diagnostics.push(formatDiagnostic(ruleSet, "reference-illegal-context", tok.line, tok.col));
      return;
    }
    if (!currentBlockType || !currentSectionKind) return; // can't determine (e.g. a bare TYPE file) -- don't guess
    const legal = ruleSet.references.declaration.legalSections[currentBlockType];
    if (!legal) return; // DATA_BLOCK -- no row in references.yaml's table
    if (!legal.includes(currentSectionKind)) {
      diagnostics.push(
        formatDiagnostic(ruleSet, "reference-illegal-section", tok.line, tok.col, {
          blockType: currentBlockType,
          section: currentSectionKind,
          legal: legal.join("/"),
        })
      );
    }
  }

  /** composition-rules.yaml's array.dimensions (1-6), array.index.valueLimits
   * ([-32768, 32767], regardless of declared index type), and
   * array.dynamicBounds.declarationSections (ARRAY[*] legal in strictly
   * fewer sections than a normal fixed-bounds array). Only flags a
   * dimension whose bounds are BOTH literal numbers -- a symbolic/constant
   * bound (not documented either way) is left unchecked rather than guessed. */
  function checkArrayDeclaration(boundsTokens: Token[], arrTok: Token, memberContext: "VAR" | "STRUCT"): void {
    if (boundsTokens.length === 1 && boundsTokens[0].kind === "punct" && boundsTokens[0].text === "*") {
      if (memberContext === "STRUCT") {
        diagnostics.push(formatDiagnostic(ruleSet, "dynamic-array-illegal-context", arrTok.line, arrTok.col));
        return;
      }
      if (currentBlockType && currentSectionKind) {
        const legal = ruleSet.composition.array.dynamicBounds?.declarationSections[currentBlockType];
        if (legal && !legal.includes(currentSectionKind)) {
          diagnostics.push(
            formatDiagnostic(ruleSet, "dynamic-array-illegal-section", arrTok.line, arrTok.col, {
              blockType: currentBlockType,
              section: currentSectionKind,
              legal: legal.join("/"),
            })
          );
        }
      }
      return;
    }

    const groups: Token[][] = [[]];
    for (const t of boundsTokens) {
      if (t.kind === "punct" && t.text === ",") groups.push([]);
      else groups[groups.length - 1].push(t);
    }

    const dims = ruleSet.composition.array.dimensions;
    if (groups.length < dims.min || groups.length > dims.max) {
      diagnostics.push(
        formatDiagnostic(ruleSet, "array-dimensions", arrTok.line, arrTok.col, { count: groups.length, min: dims.min, max: dims.max })
      );
    }

    const limits = ruleSet.composition.array.index.valueLimits;
    for (const g of groups) {
      if (g.length !== 4) continue; // not exactly `num . . num` (e.g. a symbolic/constant bound) -- don't guess
      const [numLo, dot1, dot2, numHi] = g;
      if (numLo.kind !== "number" || dot1.text !== "." || dot2.text !== "." || numHi.kind !== "number") continue;
      const lo = parseInt(numLo.text, 10);
      const hi = parseInt(numHi.text, 10);
      if (lo > hi) {
        diagnostics.push(formatDiagnostic(ruleSet, "array-bounds", numLo.line, numLo.col, { lo, hi }, { variant: "lo-gt-hi" }));
      }
      if (lo < limits.min || lo > limits.max || hi < limits.min || hi > limits.max) {
        diagnostics.push(
          formatDiagnostic(ruleSet, "array-bounds", numLo.line, numLo.col, { lo, hi, min: limits.min, max: limits.max }, { variant: "out-of-range" })
        );
      }
    }
  }

  /** references.yaml's referenceableTargets -- `Bool` is a disallowed
   * bit-string reference target (`bitStrings.disallowed`), and a sized
   * String/WString (`REF_TO String[10]`) is illegal (`characterStrings`'s
   * own "no length declaration on the reference itself" note) -- a
   * reference is always declared `REF_TO String`, unsized. Called from the
   * `REF_TO` branch of `walkTypeRef` AFTER recursing into the inner type,
   * so `inner` already reflects what's actually being referenced. Sized
   * String/WString declarations retain their capacity in the TypeRef for
   * layout calculation, so inspect that parsed value instead of looking
   * for still-unconsumed `[n]` tokens. */
  function checkReferenceTargetType(refTok: Token, inner: { topLevelName: string | null; typeRef: TypeRef | null }): void {
    if (inner.topLevelName && ruleSet.references.referenceableTargets.bitStrings.disallowed.includes(inner.topLevelName)) {
      diagnostics.push(formatDiagnostic(ruleSet, "reference-illegal-target-type", refTok.line, refTok.col, { targetType: inner.topLevelName }, { variant: "not-referenceable" }));
      return;
    }
    if (
      (inner.topLevelName === "String" || inner.topLevelName === "WString") &&
      inner.typeRef?.kind === "named" &&
      inner.typeRef.length !== undefined
    ) {
      diagnostics.push(formatDiagnostic(ruleSet, "reference-illegal-target-type", refTok.line, refTok.col, { targetType: inner.topLevelName }, { variant: "sized-string" }));
    }
  }

  /** composition-rules.yaml's array.elementType (`nestedArraysForbidden`)
   * and references.yaml's referenceableTargets.array.disallowed ("ARRAY of
   * REF_TO <type>" -- an array OF references, the reverse direction from a
   * reference TO an array, which `checkReferenceTargetType` above already
   * covers). Called from the `ARRAY` branch of `walkTypeRef` AFTER
   * recursing into the element type. */
  function checkArrayElementType(arrTok: Token, inner: { topLevelName: string | null }): void {
    if (inner.topLevelName === "Array") {
      diagnostics.push(formatDiagnostic(ruleSet, "array-nested-illegal", arrTok.line, arrTok.col));
    } else if (inner.topLevelName === "Reference") {
      diagnostics.push(formatDiagnostic(ruleSet, "array-of-reference-illegal", arrTok.line, arrTok.col));
    }
  }

  /** Every type name some instruction declares as its `instanceType` with
   * `callShape: instance-dot` (both the graphical and SCL maps) -- i.e. the
   * instruction instance structures. Built once per document walk, lazily, so
   * documents that declare no such type never pay for it. */
  let instanceTypeNamesCache: Set<string> | null = null;
  function isInstructionInstanceType(name: string): boolean {
    if (!instanceTypeNamesCache) {
      instanceTypeNamesCache = new Set<string>();
      for (const registry of [ruleSet.instructions, ruleSet.sclInstructions]) {
        for (const entry of Object.values(registry)) {
          if (entry?.callShape === "instance-dot" && typeof entry.instanceType === "string" && entry.instanceType) {
            instanceTypeNamesCache.add(entry.instanceType);
          }
        }
      }
    }
    return instanceTypeNamesCache.has(name);
  }

  /** VAR_* section keyword -> section-legality.yaml's own section key. */
  const VAR_SECTION_TO_LEGALITY_SECTION: Record<string, string> = {
    VAR_INPUT: "Input",
    VAR_OUTPUT: "Output",
    VAR_IN_OUT: "InOut",
    VAR: "Static",
    VAR_TEMP: "Temp",
    VAR_CONSTANT: "Constant",
  };

  /** section-legality.yaml's per-section `additionalDatatypes` (Variant/
   * Any/Pointer/IEC_TIMER/... each legal in some sections but not others --
   * e.g. Variant is illegal in Static/Output, Pointer only legal in
   * InOut/Input). This data existed already (loaded as
   * `ruleSet.sectionLegality`) but was previously only consulted to seed
   * the type cache's "opaque but known" names -- nothing actually checked
   * a real declaration's type against its OWN section before this.
   *
   * Deliberately skips: `context === "STRUCT"` (section-legality.yaml's own
   * "KNOWN GAP" note -- a UDT member's legal-type set isn't sourced here at
   * all, don't guess it's the same as Static's); `topLevelName ===
   * "Reference"` (REF_TO's OWN legal-section rule is a separate,
   * block-type-dependent axis already fully covered by
   * `checkReferenceLegality`/references.yaml -- "Reference" doesn't appear
   * in section-legality.yaml's lists at all, so without this skip every
   * single REF_TO declaration would be wrongly double-flagged here too);
   * and any type name this registry doesn't actually recognize (base type,
   * system type, or a section-legality opaque name) -- an unrecognized
   * name is `unknown-type`'s job to flag, not this one's, and reporting
   * both would misleadingly double-diagnose the same root cause. */
  function checkSectionLegality(nameTok: Token, topLevelName: string | null, section: string): void {
    if (!topLevelName || topLevelName === "Reference") return;
    const legalitySection = VAR_SECTION_TO_LEGALITY_SECTION[section];
    const inAllSections = ruleSet.sectionLegality.allSections.datatypes.includes(topLevelName);
    const additional = legalitySection ? ruleSet.sectionLegality.sections[legalitySection]?.additionalDatatypes ?? [] : [];
    // "Array[0..1] of" is section-legality.yaml's own placeholder meaning
    // "any array type is permitted here" -- never a literal type name to
    // match `topLevelName` against directly (see that file's own trailing note).
    const listedForSection = topLevelName === "Array" ? additional.includes("Array[0..1] of") : additional.includes(topLevelName);

    // An instruction INSTANCE type (some entry's `instanceType`, callShape:
    // instance-dot) is that instruction's own instance structure, so it is
    // declarable ONLY as FUNCTION_BLOCK instance data -- verified in TIA
    // Portal, where the same declaration in a plain DATA_BLOCK or in a
    // UDT/STRUCT is rejected. That is a per-BLOCK-TYPE rule, a different axis
    // than section-legality.yaml (sourced per VAR section), which is why these
    // names are intentionally absent from that file. Checked only for names
    // section-legality doesn't already cover, so types it DOES list (e.g.
    // IEC_TIMER, legal in InOut/Input/Static and passable to an FC) keep their
    // existing, separately-sourced handling.
    if (!inAllSections && !listedForSection && isInstructionInstanceType(topLevelName)) {
      if (currentBlockType === "FUNCTION_BLOCK" && section !== "STRUCT") return;
      // VAR_IN_OUT passes BY REFERENCE, so the declaring block never owns the
      // instance data -- it borrows an instance the caller already owns. That
      // is the standard way to hand an instruction instance to a FUNCTION,
      // which otherwise has no static area to keep one in, and it compiles.
      // The rule this check enforces is about OWNING instance data, so it has
      // nothing to say about an InOut parameter in any block type.
      if (section === "VAR_IN_OUT") return;
      const context =
        section === "STRUCT"
          ? "a STRUCT/UDT member"
          : currentBlockType
          ? `a ${currentBlockType}`
          : "this context";
      diagnostics.push(
        formatDiagnostic(ruleSet, "instance-type-illegal-context", nameTok.line, nameTok.col, { typeName: topLevelName, context })
      );
      return;
    }

    if (section === "STRUCT") return;
    if (!legalitySection) return;
    if (inAllSections) return;
    if (listedForSection) return;
    if (!ruleSet.baseTypes[topLevelName] && !ruleSet.systemTypes[topLevelName] && !ruleSet.opaqueSectionNames.has(topLevelName)) return;
    diagnostics.push(formatDiagnostic(ruleSet, "type-illegal-section", nameTok.line, nameTok.col, { typeName: topLevelName, section }));
  }

  /** Flags a literal whose classified type(s) don't include any of
   * `allowedTypes`. Silently returns if the literal's shape isn't
   * recognized at all (classifyLiteral -> null) -- "don't know" must never
   * be reported as "wrong," same discipline instruction-registry/README.md
   * applies to unfilled `dataTypes`. */
  function reportLiteralMismatch(value: { rawText: string; tok: Token }, allowedTypes: Set<string>, severity: LintSeverity, context: string): void {
    const matches = classifyLiteral(value.rawText, ruleSet);
    if (matches === null) return;
    if ([...matches].some((t) => allowedTypes.has(t))) return;
    const looksLike = matches.size > 0 ? [...matches].join("/") : "no known type";
    diagnostics.push(
      formatDiagnostic(
        ruleSet,
        "literal-type-mismatch",
        value.tok.line,
        value.tok.col,
        { context, rawText: value.rawText, looksLike, allowed: [...allowedTypes].join("/") || "?" },
        { severity }
      )
    );
  }

  /** Flags a `#tag` (or `wire#`) operand whose declared type isn't in
   * `allowedTypes` -- the operand-side counterpart to `reportLiteralMismatch`.
   * Silently skips (never guesses) when: the type couldn't be resolved at
   * all (unknown tag, or a member-access chain longer than one level);
   * it resolves to a UDT/FB (not in base-types.yaml/system-types.yaml) --
   * Siemens instruction pins essentially never name a specific user type,
   * so there's nothing meaningful to compare against; or an alias
   * (TOD/LTOD/DT) needed resolving to its canonical base-types.yaml name
   * first (via `resolveTypeAlias`) before the comparison is even valid. */
  function reportOperandTypeMismatch(operand: { topLevelName: string | null; display: string; tok: Token }, allowedTypes: Set<string>, severity: LintSeverity, context: string): void {
    // pointer-type.yaml: "Entering a value WITHOUT the P# prefix ... is
    // automatically converted to POINTER format by TIA" -- a Pointer-typed
    // pin auto-converts ANY plain tag reference (regardless of the tag's
    // OWN declared type), unlike every other type here. No instruction in
    // instruction-registry currently lists `Pointer` in a pin's dataTypes,
    // but the rule is cheap to encode now rather than false-flagging the
    // day one is added.
    if (allowedTypes.has("Pointer")) return;
    if (!operand.topLevelName) return;
    const resolved = resolveTypeAlias(operand.topLevelName, ruleSet);
    if (!ruleSet.baseTypes[resolved] && !ruleSet.systemTypes[resolved]) return;
    if (allowedTypes.has(resolved)) return;
    diagnostics.push(
      formatDiagnostic(
        ruleSet,
        "operand-type-mismatch",
        operand.tok.line,
        operand.tok.col,
        { context, display: operand.display, resolved, allowed: [...allowedTypes].join("/") || "?" },
        { severity }
      )
    );
  }

  const instanceTypeToInstructions = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(ruleSet.instructions)) {
    if (entry.instanceType) {
      const list = instanceTypeToInstructions.get(entry.instanceType) ?? [];
      list.push(name);
      instanceTypeToInstructions.set(entry.instanceType, list);
    }
  }

  /** Resolves a dot-access member read on a timer/counter/edge-detection
   * instance (`#tonX.ET`, `#trigStart.Q`, `#myCtr.CV`, ...) by looking up
   * which instruction(s) declare this instance's type as their
   * `instanceType`, then checking that instruction's own named `pins`
   * first and the well-documented implicit fields (IMPLICIT_INSTANCE_MEMBERS)
   * second. Returns `undefined` if the instance type isn't a known
   * instruction's instanceType at all, or the member name doesn't match
   * anything for it -- don't guess. */
  function resolveInstanceMember(instanceTypeName: string, memberName: string): { dataTypes: string[]; source: string } | undefined {
    for (const candidate of listInstanceMembers(ruleSet, instanceTypeName)) {
      if (candidate.name.toLowerCase() === memberName.toLowerCase()) return candidate;
    }
    return undefined;
  }

  /** slice-access.md: `.xn`/`.bn`/`.wn` bit/byte/word slicing of a tagged
   * elementary type, keyed by the tag's `sizeBits` (not its type name --
   * any 8/16/32-bit type slices the same way). Only meaningful for a tag
   * whose OWN type resolves to a known base-types.yaml elementary type;
   * returns `undefined` (don't guess) for anything else -- composite
   * types, unknown types, or a slice suffix that doesn't match `.xn`/
   * `.bn`/`.wn` at all (falls through to plain member-access handling). */
  function isSliceSelectorToken(tok: Token): boolean {
    return tok.kind === "ident" && /^([xbw])(\d+)$/i.test(tok.text);
  }

  /** True when the cursor is on the dot of `.X0` or `.%X0`. This is
   * deliberately syntax-only: it prevents a slice suffix from making its
   * scalar base look like a structured container even when that base's type
   * is temporarily unavailable. `resolveSliceAccess` still validates the
   * selector against the resolved type and reports size/range diagnostics. */
  function sliceSelectorAhead(): boolean {
    if (!cur.isPunct(".")) return false;
    const afterDot = cur.peek(1);
    if (afterDot.kind === "punct" && afterDot.text === "%") return isSliceSelectorToken(cur.peek(2));
    return isSliceSelectorToken(afterDot);
  }

  function resolveSliceAccess(baseTypeName: string, sliceTok: Token): string | undefined {
    const m = /^%?([xbw])(\d+)$/i.exec(sliceTok.text);
    if (!m) return undefined;
    const sizeBits = baseTypesByLowerName.get(baseTypeName.toLowerCase())?.sizeBits;
    if (sizeBits !== 8 && sizeBits !== 16 && sizeBits !== 32) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "slice-access-invalid-size",
          sliceTok.line,
          sliceTok.col,
          { slice: sliceTok.text, sizeBits: sizeBits ?? "?", baseTypeName },
          { variant: "non-8-16-32" }
        )
      );
      return undefined;
    }
    const kind = m[1].toLowerCase();
    const index = parseInt(m[2], 10);
    const maxIndex = kind === "x" ? sizeBits - 1 : kind === "b" ? sizeBits / 8 - 1 : sizeBits / 16 - 1;
    if (kind === "w" && sizeBits === 8) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "slice-access-invalid-size",
          sliceTok.line,
          sliceTok.col,
          { slice: sliceTok.text, baseTypeName },
          { variant: "word-on-8bit" }
        )
      );
      return undefined;
    }
    if (index > maxIndex) {
      diagnostics.push(
        formatDiagnostic(ruleSet, "slice-access-out-of-range", sliceTok.line, sliceTok.col, { slice: sliceTok.text, index, maxIndex, sizeBits })
      );
    }
    return kind === "x" ? "Bool" : kind === "b" ? "Byte" : "Word";
  }

  function push(tok: Token, tokenType: string, tokenModifiers: string[], hoverMarkdown?: string, definition?: Location, renameKey?: string): void {
    spans.push({ line: tok.line, startCol: tok.col, length: tok.text.length, tokenType, tokenModifiers, hoverMarkdown, definition, renameKey });
  }

  /** Maps a literal's TEXT to a semantic-token (type, modifiers) pair so
   * different literal families are visually distinguishable -- a plain
   * `4`, a `16#FF` bit pattern, a `T#10S` duration, a `D#2026-1-1` date,
   * and a `P#DB10.DBX20.0` pointer all currently render identically
   * otherwise. Independent of whether the literal actually matches its
   * declared/expected type -- that's `reportLiteralMismatch`'s job. */
  function literalSemantics(rawText: string): { tokenType: string; tokenModifiers: string[] } {
    switch (detectLiteralShape(rawText)) {
      case "bool":
        return { tokenType: "booleanLiteral", tokenModifiers: [] };
      case "char":
        return { tokenType: "charLiteral", tokenModifiers: [] };
      case "string":
        return { tokenType: "string", tokenModifiers: [] };
      case "float":
        return { tokenType: "number", tokenModifiers: ["float"] };
      case "radix":
        return { tokenType: "number", tokenModifiers: ["radix"] };
      case "time":
        return { tokenType: "timeLiteral", tokenModifiers: [] };
      case "date":
        return { tokenType: "dateLiteral", tokenModifiers: [] };
      case "pointer":
        return { tokenType: "pointerLiteral", tokenModifiers: [] };
      case "decimal":
      default:
        return { tokenType: "number", tokenModifiers: [] };
    }
  }

  function pushRun(
    startTok: Token,
    length: number,
    tokenType: string,
    tokenModifiers: string[],
    hoverMarkdown?: string,
    definition?: Location,
    renameKey?: string
  ): void {
    spans.push({ line: startTok.line, startCol: startTok.col, length, tokenType, tokenModifiers, hoverMarkdown, definition, renameKey });
  }

  function hoverTitle(symbol: string, kind: string): string[] {
    return [`### \`${symbol}\``, `_${kind}_`];
  }

  function hoverSource(file: string): string[] {
    return ["---", `**Source**  `, `\`${file}\``];
  }

  function standardLayoutLines(layout: TypeLayoutResult, layoutName: string): string[] {
    if (!isStandardTypeLayout(layout)) {
      const lines = ["**Storage**", "", `> Size unavailable for the **${layoutName}** layout.`];
      if (layout.unknownSizes.length === 0) return [...lines, "", `_${layout.unavailable}_`];
      const count = layout.unknownSizes.length;
      lines.push(
        "",
        `${count} unknown-size dependenc${count === 1 ? "y" : "ies"} prevent${count === 1 ? "s" : ""} a complete calculation:`,
        ""
      );
      for (const issue of layout.unknownSizes) {
        const path = issue.path.reduce((rendered, segment) => {
          if (segment === "[]") return `${rendered}[]`;
          return rendered.length > 0 ? `${rendered}.${segment}` : segment;
        }, "");
        lines.push(`- \`${path || "type itself"}\` — \`${issue.typeName}\`  `, `  ${issue.reason}`);
      }
      return lines;
    }
    const padding = layout.paddingBits === undefined ? "included; not itemized" : formatStorageBits(layout.paddingBits);
    return [
      "**Storage**",
      "",
      `- **Layout:** ${layoutName}`,
      `- **Size:** \`${formatStorageBits(layout.sizeBits)}\``,
      `- **Padding included:** \`${padding}\``,
    ];
  }

  function formatMemberOffset(offsetBits: number, sizeBits: number): string {
    const byte = Math.floor(offsetBits / 8);
    const bit = offsetBits % 8;
    return sizeBits === 1 || bit !== 0 ? `\`${byte}.${bit}\` (byte.bit)` : `byte \`${byte}\``;
  }

  function memberUnavailableReason(layout: TypeLayoutResult): string | undefined {
    if (isStandardTypeLayout(layout)) return undefined;
    return layout.unknownSizes
      .map((issue) => {
        const nestedPath = issue.path.reduce(
          (rendered, segment) => (segment === "[]" ? `${rendered}[]` : rendered ? `${rendered}.${segment}` : segment),
          ""
        );
        return `${nestedPath ? `\`${nestedPath}\` → ` : ""}\`${issue.typeName}\`: ${issue.reason}`;
      })
      .join("; ");
  }

  function memberStorageHover(
    decl: LocalDecl,
    placement: NonNullable<TypeLayoutResult["memberLayouts"]>[number],
    ownerKind: string,
    layoutName: string,
    caveat?: string
  ): string {
    const lines = [...hoverTitle(decl.name, ownerKind), "", `**Type:** \`${typeRefToText(decl.typeRef)}\``, "", "**Storage**", ""];
    if (isStandardTypeLayout(placement.layout)) {
      lines.push(`- **Size:** \`${formatStorageBits(placement.layout.sizeBits)}\``);
      if (placement.offsetBits === undefined) {
        lines.push("- **Offset:** _unavailable_");
        lines.push("", "> The offset depends on an earlier member whose size is unknown.");
      } else {
        lines.push(`- **Offset:** ${formatMemberOffset(placement.offsetBits, placement.layout.sizeBits)}`);
      }
    } else {
      lines.push("- **Size:** _unavailable_", "- **Offset:** _unavailable_");
      const reason = memberUnavailableReason(placement.layout);
      if (reason) lines.push("", `> ${reason}`);
    }
    lines.push(`- **Layout:** ${layoutName}`);
    if (caveat) lines.push("", `> ${caveat}`);
    return lines.join("\n");
  }

  function applyMemberStorageHovers(
    declarations: LocalDecl[],
    ownerKind: string,
    layoutName: string,
    caveat?: string
  ): void {
    if (declarations.length === 0) return;
    const result = calculateStandardMemberLayout(
      declarations.map((decl) => ({ name: decl.name, typeRef: decl.typeRef, line: decl.line })),
      ruleSet,
      typeCache
    );
    const placements = result.memberLayouts;
    if (!placements) return;
    for (let i = 0; i < declarations.length && i < placements.length; i++) {
      const spanIndex = declarations[i].declarationSpanIndex;
      if (spanIndex === undefined || !spans[spanIndex]) continue;
      spans[spanIndex].hoverMarkdown = memberStorageHover(declarations[i], placements[i], ownerKind, layoutName, caveat);
    }
  }

  function dataBlockLayout(block: BlockInfo): TypeLayoutResult {
    // A global DB owns its declarations directly. An empty quoted instanceOf
    // can instead be a DB based on a PLC data type; FB/instruction instance
    // DB sizes include compiler/runtime storage that this source index cannot
    // derive safely.
    if (block.vars.size > 0 || !block.instanceOf) {
      return calculateStandardMemberLayout(
        [...block.vars.values()].map((variable) => variable.member),
        ruleSet,
        typeCache
      );
    }
    if (block.instanceOf.quoted) {
      const typeInfo = typeCache ? lookupType(typeCache, block.instanceOf.name) : undefined;
      if (typeInfo?.kind === "udt") return calculateStandardUdtLayout(typeInfo.name, ruleSet, typeCache);
    }
    return { unavailable: "instance DB size depends on compiler-generated instance storage", unknownSizes: [] };
  }

  function dataBlockSizeLines(block: BlockInfo): string[] {
    if (block.blockType !== "DATA_BLOCK") return [];
    const layout = dataBlockLayout(block);
    if (block.optimizedAccess === false) {
      return standardLayoutLines(layout, "Siemens standard / non-optimized");
    }
    const lines = standardLayoutLines(layout, "Siemens standard transfer");
    if (block.optimizedAccess === true) {
      lines.push("", "> The physical optimized size is target-system dependent and has no fixed source-level layout.");
    } else {
      lines.push("", "> Access mode is not declared in this source, so the deterministic Siemens standard layout is shown.");
    }
    return lines;
  }

  function renderWorkspaceBlockHover(block: BlockInfo): string {
    const lines = hoverTitle(block.name, block.blockType.replace(/_/g, " ").toLowerCase());
    const sizeLines = dataBlockSizeLines(block);
    if (sizeLines.length > 0) lines.push("", ...sizeLines);
    lines.push("", ...hoverSource(block.file));
    return lines.join("\n");
  }

  function typeHover(name: string): string | undefined {
    // SCL type names are case-insensitive. Resolve the source spelling to
    // the registry's canonical key before rendering so `WORD`/`word` gets
    // the same hover as `Word` (and likewise for system structs/aliases).
    const baseCanonicalName = baseTypeCanonicalNames.get(name.toLowerCase());
    if (baseCanonicalName) return renderBaseTypeHover(baseCanonicalName, ruleSet.baseTypes[baseCanonicalName]);
    const systemCanonicalName = systemTypeCanonicalNames.get(name.toLowerCase());
    if (systemCanonicalName) return renderSystemTypeHover(systemCanonicalName, ruleSet.systemTypes[systemCanonicalName]);
    const udt = typeCache ? lookupType(typeCache, name) : undefined;
    if (udt?.kind === "udt") {
      const lines = [
        ...hoverTitle(udt.name, "PLC data type"),
        "",
        ...standardLayoutLines(calculateStandardUdtLayout(udt.name, ruleSet, typeCache), "Siemens standard / non-optimized"),
      ];
      if (udt.sourceFile) lines.push("", ...hoverSource(udt.sourceFile));
      return lines.join("\n");
    }
    const blk = blockIndex.get(name);
    if (blk) return renderWorkspaceBlockHover(blk);
    const viaInstruction = instanceTypeToInstructions.get(name);
    if (viaInstruction && viaInstruction.length > 0) {
      return `**${name}** _(instance type)_\n\nused by instruction${viaInstruction.length > 1 ? "s" : ""}: ${viaInstruction.map((n) => `\`${n}\``).join(", ")}`;
    }
    return undefined;
  }

  /** SCL's own "uniform adaptations" (mirrors linter/sclInstructionChecks.ts's
   * `adaptEntryForScl`): `S7_Templates` doesn't exist in SCL at all, so
   * `template` is always suppressed regardless of where `entry` came from.
   * `required` is trickier -- only relax it to `false` when `source` is
   * `"shared"` (a `ruleSet.instructions` entry borrowed as-is from the FBD
   * registry, whose `required` flags reflect FBD's stricter compile rule,
   * confirmed not to apply to SCL). A `"scl"`-sourced entry (a dedicated
   * `*-SCL.yaml` file) already encodes real SCL-accurate `required` flags
   * in its own data -- e.g. `11-conversion-SCL.yaml`'s `LREAL_TO_REAL`
   * correctly requires its sole input -- so leave those alone. */
  function adaptEntryForScl(entry: InstructionEntry, source: "scl" | "shared"): InstructionEntry {
    return {
      ...entry,
      pins: source === "shared" ? entry.pins.map((p) => ({ ...p, required: false })) : entry.pins,
      template: { shape: "none", keys: [], extra: {} },
    };
  }

  /** Resolves `name` against the SCL-visible registries -- dedicated
   * `ruleSet.sclInstructions` entry first, `ruleSet.instructions` shared/
   * FBD-cased entry as fallback -- mirrors `sclInstructionChecks.ts`'s own
   * `findEntry`. Kept as a small local duplicate rather than an import --
   * that module already imports `resolveInstanceTypeToInstructionNames`
   * FROM this file, so the reverse import would be circular. Only ever
   * used from an SCL body context (a LAD/FBD RUNG call keeps its existing
   * `ruleSet.instructions`-only lookup, which doesn't need the SCL
   * adaptations below). */
  function findSclInstruction(name: string): InstructionEntry | undefined {
    const scl = ruleSet.sclInstructions[name];
    if (scl) return adaptEntryForScl(scl, "scl");
    const shared = ruleSet.instructions[name];
    return shared ? adaptEntryForScl(shared, "shared") : undefined;
  }

  /** Hover markdown for a quoted external block reference (`"Name"(...)` /
   * `"Name".member`).
   *
   * An INSTANCE DATA_BLOCK additionally resolves WHAT it is an instance of, so
   * hovering `"R_TRIG_DB"()` shows R_TRIG's own signature from the instruction
   * registry instead of just "(data block)":
   *   - an `InstructionName := 'R_TRIG'` header pragma, or an unquoted
   *     instance-of line, resolves against the instruction registry;
   *   - a quoted instance-of line is a user FUNCTION_BLOCK single-instance DB
   *     (or a PLC-data-type-based DB), resolved against the workspace index.
   * See parser/s7dclParser.ts's `ParsedBlockFile.instanceOf` for both shapes. */
  /** Standard semantic type for a reference to a WORKSPACE BLOCK by name --
   * quoted (`"DB_IPC_Comms".Slots` / `"_IPC_SetRunning"(...)`) or, for a
   * call, bare (`Helper(...)`). Decided by WHAT THE SYMBOL IS, not by how
   * this particular reference uses it, so one block reads the same colour
   * everywhere it appears:
   *   - a plain/UDT-backed DATA_BLOCK is global structured storage
   *     (`s7DataBlock`, inheriting `variable`);
   *   - an FB/instruction instance DATA_BLOCK is a callable instance
   *     (`s7CallableInstance`);
   *   - a FUNCTION_BLOCK declaration/reference is an instantiable type
   *     (`class`), comparable to a class in an OO language;
   *   - an FC/OB is executable (`function`);
   *   - an unresolved name says nothing about itself, so it stays a plain
   *     `variable` rather than claiming a kind this pass can't verify. */
  function externalRefTokenType(ownerBlock: BlockInfo | undefined): string {
    if (!ownerBlock) return "variable";
    if (ownerBlock.blockType === "DATA_BLOCK") {
      const inst = ownerBlock.instanceOf;
      const callableInstance = Boolean(
        ownerBlock.instructionName ||
        (inst && !inst.quoted && resolveInstanceTypeToInstructionNames(ruleSet, inst.name).length > 0) ||
        (inst?.quoted && blockIndex.get(inst.name)?.blockType === "FUNCTION_BLOCK")
      );
      return callableInstance ? "s7CallableInstance" : "s7DataBlock";
    }
    if (ownerBlock.blockType === "FUNCTION_BLOCK") return "s7CallableType";
    return "function";
  }

  function renderExternalBlockHover(extName: string, ownerBlock: BlockInfo | undefined): string {
    if (!ownerBlock) return `**"${extName}"** — not found in workspace`;
    const kindOf = (t: string) => t.replace(/_/g, " ").toLowerCase();
    const lines = hoverTitle(`"${extName}"`, kindOf(ownerBlock.blockType));
    const sizeLines = dataBlockSizeLines(ownerBlock);
    if (sizeLines.length > 0) lines.push("", ...sizeLines);
    lines.push("", ...hoverSource(ownerBlock.file));
    const inst = ownerBlock.instanceOf;
    if (ownerBlock.blockType === "DATA_BLOCK" && inst) {
      // The InstructionName pragma is authoritative when present; otherwise an
      // unquoted instance-of line names the instruction/system type directly.
      const instrName = ownerBlock.instructionName ?? (inst.quoted ? undefined : inst.name);
      const entry = instrName ? findSclInstruction(instrName) : undefined;
      if (instrName && entry) {
        lines.push("", "---", "", `instance of instruction:`, "", renderInstructionHover(instrName, entry, true));
      } else if (inst.quoted) {
        const target = blockIndex.get(inst.name);
        lines.push(
          "",
          "---",
          "",
          target
            ? `single instance of **"${inst.name}"** _(${kindOf(target.blockType)})_\n\ndeclared in \`${target.file}\``
            : `instance of **"${inst.name}"** — not found in workspace`
        );
      } else if (instrName) {
        lines.push("", "---", "", `instance of \`${instrName}\` — not in instruction-registry`);
      }
    }
    return lines.join("\n");
  }

  function renderGlobalTagHover(tag: GlobalTagInfo): string {
    const lines = hoverTitle(`"${tag.name}"`, "PLC tag");
    lines.push(`type: \`${tag.dataTypeName}\``);
    if (tag.logicalAddress) lines.push(`address: \`${tag.logicalAddress}\``);
    const comment = tag.comments.get(mlcLocale) ?? tag.comments.get("en-US") ?? tag.comments.values().next().value;
    if (comment) lines.push("", comment);
    lines.push("", ...hoverSource(tag.file));
    return lines.join("\n");
  }

  /** For an FB single-instance DB (`DATA_BLOCK "Pump_DB" ... "FB_Pump"`), the
   * FUNCTION_BLOCK whose interface supplies the DB's members -- the DB itself
   * has no VAR section to resolve `"Pump_DB".q_y` against. */
  function instanceTargetBlock(blk: BlockInfo): BlockInfo | undefined {
    if (blk.blockType !== "DATA_BLOCK" || !blk.instanceOf?.quoted) return undefined;
    const target = blockIndex.get(blk.instanceOf.name);
    return target && target.name !== blk.name ? target : undefined;
  }

  /** For an instruction instance DB (`DATA_BLOCK "R_TRIG_DB" ... R_TRIG`), the
   * named member of the instruction it instances -- its pins plus the implicit
   * instance members, exactly what `#inst.member` resolution already uses.
   * Matched case-insensitively: the registry's graphical entry may spell a pin
   * `q` while SCL writes `Q`. */
  function instanceDbInstructionMember(blk: BlockInfo, member: string): { name: string; dataTypes: string[]; source: string } | undefined {
    if (blk.blockType !== "DATA_BLOCK") return undefined;
    const instanceType = blk.instructionName ?? (blk.instanceOf && !blk.instanceOf.quoted ? blk.instanceOf.name : undefined);
    if (!instanceType) return undefined;
    const wanted = member.toLowerCase();
    return listInstanceMembers(ruleSet, instanceType, true).find((m) => m.name.toLowerCase() === wanted);
  }

  function typeDefinition(name: string): Location | undefined {
    const udt = typeCache ? lookupType(typeCache, name) : undefined;
    if (udt?.kind === "udt" && udt.sourceFile) return { file: udt.sourceFile, line: udt.declLine ?? 1 };
    const blk = blockIndex.get(name);
    if (blk) return { file: blk.file, line: blk.declLine };
    return undefined;
  }

  /** Classifies a type-reference token sequence starting at `cur` (after a
   * `:`), pushing spans for ARRAY/OF/STRUCT/END_STRUCT keywords and the
   * leaf type name. Best-effort mirror of parseTypeRefFromCursor in
   * typeRef.ts, kept separate because that one doesn't retain per-token
   * positions needed for hover/semantic spans. */
  function walkTypeRef(
    memberContext: "VAR" | "STRUCT"
  ): { text: string; typeRef: TypeRef | null; leafName: string | null; topLevelName: string | null; derefTopLevelName: string | null; arrayBounds: [number, number][] | null; elementTopLevelName: string | null; elementLeafName: string | null; structMembers?: LocalDecl[] } {
    if (cur.isIdent("REF_TO")) {
      const refTok = cur.next();
      push(refTok, "s7GenericType", ["defaultLibrary"]);
      checkReferenceLegality(refTok, memberContext);
      const inner = walkTypeRef(memberContext);
      checkReferenceTargetType(refTok, inner);
      return {
        text: `REF_TO ${inner.text}`,
        typeRef: inner.typeRef ? { kind: "reference", of: inner.typeRef } : null,
        leafName: inner.leafName,
        topLevelName: "Reference",
        derefTopLevelName: inner.topLevelName,
        arrayBounds: null,
        elementTopLevelName: null,
        elementLeafName: null,
      };
    }
    if (cur.isIdent("ARRAY")) {
      const arrTok = cur.next();
      push(arrTok, "s7GenericType", ["defaultLibrary"]);
      cur.tryPunct("[");
      const boundsTokens: Token[] = [];
      while (!cur.isPunct("]") && !cur.atEnd()) boundsTokens.push(cur.next());
      cur.tryPunct("]");
      checkArrayDeclaration(boundsTokens, arrTok, memberContext);
      if (cur.isIdent("of")) push(cur.next(), "s7GenericType", ["defaultLibrary"]);
      const inner = walkTypeRef(memberContext);
      checkArrayElementType(arrTok, inner);
      return {
        text: `Array[...] of ${inner.text}`,
        typeRef: inner.typeRef ? { kind: "array", bounds: parseBoundsGroups(boundsTokens) ?? [], of: inner.typeRef } : null,
        leafName: inner.leafName,
        topLevelName: "Array",
        derefTopLevelName: null,
        arrayBounds: parseBoundsGroups(boundsTokens),
        elementTopLevelName: inner.topLevelName,
        elementLeafName: inner.leafName,
      };
    }
    if (cur.isIdent("STRUCT")) {
      push(cur.next(), "struct", ["defaultLibrary"]);
      // An inline STRUCT has no named type to look its fields up from
      // later, so they're collected here as the walk passes them -- see
      // `LocalDecl.structMembers`.
      const structMembers: LocalDecl[] = [];
      while (!cur.isIdent("END_STRUCT") && !cur.atEnd()) {
        const member = walkVarMember("STRUCT");
        if (member) structMembers.push(member);
      }
      if (cur.isIdent("END_STRUCT")) push(cur.next(), "struct", ["defaultLibrary"]);
      applyMemberStorageHovers(
        structMembers,
        "STRUCT member",
        "Siemens standard / non-optimized (relative to this STRUCT)"
      );
      return {
        text: "STRUCT",
        typeRef: { kind: "inline-struct", members: structMembers.map((member) => ({ name: member.name, typeRef: member.typeRef, line: member.line })) },
        leafName: null,
        topLevelName: "Struct",
        derefTopLevelName: null,
        arrayBounds: null,
        elementTopLevelName: null,
        elementLeafName: null,
        structMembers,
      };
    }
    if (cur.peek().kind === "string") {
      const t = cur.next();
      const name = t.value ?? t.text;
      pushTypeNameSpan(t, name, t.text.length);
      return {
        text: name,
        typeRef: { kind: "named", name, quoted: true, namespace: null },
        leafName: name,
        topLevelName: name,
        derefTopLevelName: null,
        arrayBounds: null,
        elementTopLevelName: null,
        elementLeafName: null,
      };
    }
    if (cur.peek().kind !== "ident") {
      return { text: "", typeRef: null, leafName: null, topLevelName: null, derefTopLevelName: null, arrayBounds: null, elementTopLevelName: null, elementLeafName: null };
    }

    const parts: Token[] = [cur.next()];
    while (cur.isPunct(".")) {
      cur.next();
      if (cur.peek().kind === "string" || cur.peek().kind === "ident") parts.push(cur.next());
    }
    for (let i = 0; i < parts.length - 1; i++) push(parts[i], "namespace", []);
    const leaf = parts[parts.length - 1];
    const leafName = leaf.kind === "string" ? leaf.value ?? leaf.text : leaf.text;
    pushTypeNameSpan(leaf, leafName, leaf.text.length);
    let declaredLength: number | undefined;
    if (/^(String|WString)$/i.test(leafName) && cur.isPunct("[")) {
      cur.next();
      const lengthTok = cur.peek();
      if (lengthTok.kind === "number" && /^\d+$/.test(lengthTok.text)) {
        declaredLength = parseInt(lengthTok.text, 10);
        push(cur.next(), "number", []);
      }
      while (!cur.isPunct("]") && !cur.atEnd()) cur.next();
      cur.tryPunct("]");
    }
    return {
      text: `${parts.map((p) => (p.kind === "string" ? p.value ?? p.text : p.text)).join(".")}${declaredLength === undefined ? "" : `[${declaredLength}]`}`,
      typeRef: {
        kind: "named",
        name: leafName,
        quoted: leaf.kind === "string",
        namespace: parts.length > 1 ? parts.slice(0, -1).map((p) => (p.kind === "string" ? p.value ?? p.text : p.text)).join(".") : null,
        length: declaredLength,
      },
      leafName,
      topLevelName: leafName,
      derefTopLevelName: null,
      arrayBounds: null,
      elementTopLevelName: null,
      elementLeafName: null,
    };
  }

  /** Semantic (type, modifiers) for one TYPE-NAME occurrence -- a VAR
   * member's declared type, an `ARRAY ... OF <here>` element type, a
   * FUNCTION's return type, a block/UDT's own declared name. One function
   * so the SAME type reads identically everywhere it appears; a declaration
   * that looked different from a reference to it was the whole problem.
   *
   * Elementary Siemens types use the six user-facing datatype families below.
   * The grouping is explicit rather than copied directly from
   * base-types.yaml because it intentionally combines signed/unsigned
   * integers with bit strings, and characters with strings:
   *
   *   s7CallableType           -- a workspace FUNCTION_BLOCK type.
   *   s7CallableType.defaultLibrary -- a Siemens instruction instance type
   *                               (TON, R_TRIG, CTU_INT, ...).
   *   s7DataBlock              -- a global/UDT-backed DATA_BLOCK object.
   *   s7TemporalType.defaultLibrary -- S5Time/Time/Date/TOD/DTL family.
   *   s7IntegerType.defaultLibrary  -- signed/unsigned integers + bit strings.
   *   s7BooleanType.defaultLibrary  -- Bool.
   *   s7FloatType.defaultLibrary    -- Real/LReal.
   *   s7GenericType.defaultLibrary  -- Void/Variant/Any/Pointer/Reference,
   *                                    including REF_TO and ARRAY/OF.
   *   s7TextType.defaultLibrary     -- String/WString/Char/WChar.
   *   struct.defaultLibrary    -- a Siemens structured/runtime type
   *                               (IEC_TIMER, ErrorStruct, ...).
   *   s7UdtType                -- a project-authored PLC data type (UDT),
   *                               or a type name this pass can't resolve.
   *
   * `Array`/`Struct`/`REF_TO` normally do not reach here -- they are type constructors
   * classified by `walkTypeRef`, which lets a composite declaration read
   * like `List<Element>`, `object`, or `reference` at a glance. */
  function typeNameSemantics(name: string): { tokenType: string; tokenModifiers: string[] } {
    const udt = typeCache ? lookupType(typeCache, name) : undefined;
    if (udt?.kind === "udt") return { tokenType: "s7UdtType", tokenModifiers: [] };
    const blk = blockIndex.get(name);
    if (blk) return { tokenType: externalRefTokenType(blk), tokenModifiers: [] };
    if (resolveInstanceTypeToInstructionNames(ruleSet, name).length > 0) {
      return { tokenType: "s7CallableType", tokenModifiers: ["defaultLibrary"] };
    }
    // Case-insensitive: BYTE/Byte/byte are the same SCL type.
    const lower = name.toLowerCase();
    const groupedPrimitive = BUILTIN_TYPE_SEMANTICS[lower];
    if (groupedPrimitive) return { tokenType: groupedPrimitive, tokenModifiers: ["defaultLibrary"] };
    if (primitiveTypeNames.has(lower)) return { tokenType: "type", tokenModifiers: ["defaultLibrary"] };
    if (systemTypeNames.has(lower)) return { tokenType: "struct", tokenModifiers: ["defaultLibrary"] };
    return { tokenType: "s7UdtType", tokenModifiers: [] };
  }

  function pushTypeNameSpan(tok: Token, name: string, length: number, extraModifiers: string[] = []): void {
    // A workspace UDT is resolved through the canonical, case-insensitive
    // type cache. Base/system types remain fixed Siemens names and therefore
    // never receive a rename key. A block type uses the pre-existing `type:`
    // identity when no UDT owns this type-reference name.
    const udt = typeCache ? lookupType(typeCache, name) : undefined;
    const resolvedUdt = udt?.kind === "udt" ? udt : undefined;
    const blk = resolvedUdt ? undefined : blockIndex.get(name);
    const { tokenType, tokenModifiers } = typeNameSemantics(name);
    spans.push({
      line: tok.line,
      startCol: tok.col,
      length,
      tokenType,
      tokenModifiers: [...tokenModifiers, ...extraModifiers],
      hoverMarkdown: typeHover(name),
      definition: typeDefinition(name),
      renameKey: resolvedUdt ? `udt:${resolvedUdt.name}` : blk ? `type:${blk.name}` : undefined,
    });
  }

  /** `S7_MLC`/`S7_NetworkTitle`/etc.'s value is an `.s7res` MultiLingualTexts
   * ID, not inline text -- resolves it (configured locale, with fallback)
   * and pushes a span carrying BOTH a hover (the resolved text) and a
   * `definition` (jump to that ID's `- id:` line in the sibling `.s7res`),
   * plus `inlineHint` for the always-visible decoration in providers/mlcHints.ts. */
  function classifyMlcPragmaValue(valueTok: Token): void {
    const id = valueTok.value ?? valueTok.text;
    const res = getS7Res();
    const entry: S7ResEntry | undefined = res?.entries.get(id);
    if (!entry) {
      push(valueTok, "string", [], `**${id}** -- ${res ? "not found in" : "no"} \`${docPath ? siblingS7ResPath(docPath).split(/[\\/]/).pop() : ".s7res"}\``);
      return;
    }
    const resolved = resolveMlcText(entry, mlcLocale);
    const hover = resolved
      ? `**${id}** _(${resolved.locale})_\n\n${resolved.text}`
      : `**${id}** -- no text for any locale`;
    const resPath = docPath ? siblingS7ResPath(docPath) : undefined;
    const definition: Location | undefined = resPath ? { file: resPath, line: entry.idLine, col: entry.idCol } : undefined;
    push(valueTok, "string", [], hover, definition, resPath ? `mlc:${id}\0${resPath}` : undefined);
    if (resolved) spans[spans.length - 1].inlineHint = resolved.text.split(/\r\n|\n/, 1)[0];
  }

  function classifyPragma(): void {
    if (!cur.isPunct("{")) return;
    cur.next();
    while (!cur.isPunct("}") && !cur.atEnd()) {
      if (cur.peek().kind === "ident" && cur.peek(1).kind === "op" && cur.peek(1).text === ":=") {
        const keyTok = cur.next();
        push(keyTok, "property", ["declaration"], pragmaHover(keyTok.text));
        cur.next(); // ':='
        const isMlcKey = MLC_ID_PRAGMA_KEYS.has(keyTok.text);
        if (isMlcKey && cur.peek().kind === "string") {
          classifyMlcPragmaValue(cur.next());
        } else if (!cur.atEnd() && !cur.isPunct(";") && !cur.isPunct("}")) {
          const valueTok = cur.next();
          // A pragma value is ATTRIBUTE data, never program data: the
          // `'TRUE'` in `{ S7_Optimized_Access := 'TRUE' }` is the quoted
          // string "TRUE" configuring the block, not the boolean constant
          // `TRUE`, and must not read as one (nor as a keyword). Quoted ->
          // `string`; a bare value keeps its own literal semantics.
          if (valueTok.kind === "string") push(valueTok, "string", []);
          else if (valueTok.kind === "number" || valueTok.kind === "ident") {
            const { tokenType, tokenModifiers } = literalSemantics(valueTok.text);
            push(valueTok, tokenType, tokenModifiers);
          }
        }
        cur.tryPunct(";");
        continue;
      }
      cur.next();
    }
    cur.tryPunct("}");
  }

  /** Classifies literals/operators found while skipping over a default
   * value or a pin's value expression, without trying to fully parse it. */
  function classifyLiteralOrSkip(): boolean {
    if (cur.isIdent("NOT")) {
      push(cur.next(), "operator", []);
      return true;
    }
    const value = consumeLiteralValue(cur, ruleSet);
    if (!value) return false;
    const { tokenType, tokenModifiers } = literalSemantics(value.rawText);
    pushRun(value.tok, value.spanLength, tokenType, tokenModifiers);
    return true;
  }

  function skipToSemicolon(): void {
    let depth = 0;
    while (!cur.atEnd()) {
      if (cur.isPunct("(") || cur.isPunct("[")) {
        depth++;
        cur.next();
        continue;
      }
      if (cur.isPunct(")") || cur.isPunct("]")) {
        depth--;
        cur.next();
        continue;
      }
      if (cur.isPunct("{")) {
        classifyPragma();
        continue;
      }
      if (cur.isPunct(";") && depth <= 0) {
        cur.next();
        return;
      }
      if (classifyLiteralOrSkip()) continue;
      cur.next();
    }
  }

  /** Returns the `LocalDecl` it recorded, so `walkTypeRef`'s inline-STRUCT
   * branch can keep the fields it just walked (see `LocalDecl.structMembers`).
   * `undefined` when the cursor wasn't at a member at all. */
  function walkVarMember(context: "VAR" | "STRUCT"): LocalDecl | undefined {
    // A .s7dcl EXPORT's VAR sections put the pragma BEFORE the name; an
    // authored .scl source file's VAR sections instead follow the SAME
    // convention STRUCT bodies already use -- pragma AFTER the name (see
    // parser/s7dclParser.ts's own parseVarMember, confirmed against real
    // project .scl files, e.g. `ResetEdge {InstructionName := 'R_TRIG'; ...}
    // : R_TRIG;`). That parser checks BOTH positions unconditionally rather
    // than gating on section context, so this mirrors it -- without the
    // AFTER check here, an authored-.scl instance declaration's `{...}`
    // pragma block is left sitting where `:` is expected, and walkTypeRef
    // silently returns an empty type for it.
    classifyPragma();
    if (cur.isIdent("END_VAR") || cur.isIdent("END_STRUCT") || cur.atEnd()) return undefined;
    const nameTok = cur.next();
    classifyPragma();
    const section = context === "STRUCT" ? "STRUCT" : currentSectionKind ?? "VAR";
    const declSpanIndex = spans.length;
    push(nameTok, "variable", ["declaration"], undefined, undefined, memberRenameKey(nameTok.text, section));
    cur.tryPunct(":");
    const { text, typeRef, leafName, topLevelName, derefTopLevelName, arrayBounds, elementTopLevelName, elementLeafName, structMembers } = walkTypeRef(context);
    checkSectionLegality(nameTok, topLevelName, section);
    const decl: LocalDecl = {
      name: nameTok.text,
      leafName,
      topLevelName,
      derefTopLevelName,
      arrayBounds,
      elementTopLevelName,
      elementLeafName,
      typeText: text,
      typeRef: typeRef ?? { kind: "named", name: "", quoted: false, namespace: null },
      line: nameTok.line,
      col: nameTok.col,
      section,
      structMembers,
      declarationSpanIndex: declSpanIndex,
    };
    localDecls.set(nameTok.text, decl);
    // A STRUCT/UDT field is reachable as `#owner.field`, never as a base tag
    // of its own -- so only VAR-section members join the block's scope.
    if (context === "VAR") currentBlockTags.set(nameTok.text.toLowerCase(), decl);
    // The declared type is only known AFTER walkTypeRef, so the name's own
    // span is retyped here rather than guessed at push time. Instance names
    // remain variables/properties/parameters; their declared FB/timer type is
    // separately classified as `class` by `walkTypeRef`.
    if (spans[declSpanIndex]) {
      spans[declSpanIndex].tokenType = localTagTokenType(decl);
      spans[declSpanIndex].tokenModifiers.push(...localDeclCapabilities(decl));
    }
    if (cur.isOp(":=")) {
      const assignTok = cur.next();
      if (topLevelName === "Reference") {
        diagnostics.push(formatDiagnostic(ruleSet, "reference-manual-initial-value", assignTok.line, assignTok.col));
      }
      const value = consumeLiteralValue(cur, ruleSet);
      if (value) {
        const { tokenType, tokenModifiers } = literalSemantics(value.rawText);
        pushRun(value.tok, value.spanLength, tokenType, tokenModifiers);
        if (topLevelName !== "Reference" && leafName && ruleSet.baseTypes[leafName]) {
          reportLiteralMismatch(value, new Set([leafName]), "error", `default value for '${nameTok.text}'`);
        }
      }
    }
    skipToSemicolon();
    return decl;
  }

  /** Consumes a `[index[, index...]]` suffix on an array-typed tag
   * (`#myArr[0]`, `#myMatrix[i, 2]`) and returns its display text.
   * composition-rules.yaml's `array.index.actualParameterRule`: a bare
   * constant or a bare variable is legal per dimension, a variable
   * EXPRESSION (`#i + 1`) is not -- flagged as a warning (this is a
   * shape heuristic, not a full expression parser). A literal numeric
   * index is additionally range-checked against `bounds` (the array's own
   * declared bounds, per dimension) when known. */
  function consumeArrayIndex(arrayTok: Token, bounds: [number, number][] | null): string {
    if (!cur.isPunct("[")) return "";
    let text = cur.next().text; // '['
    let dim = 0;
    while (!cur.isPunct("]") && !cur.atEnd()) {
      const operand = walkOperandRef();
      if (operand) {
        text += operand.display;
      } else {
        const lit = consumeLiteralValue(cur, ruleSet);
        if (lit) {
          text += lit.rawText;
          const num = parseInt(lit.rawText, 10);
          const dimBounds = bounds?.[dim];
          if (!Number.isNaN(num) && dimBounds) {
            const [lo, hi] = dimBounds;
            if (num < lo || num > hi) {
              diagnostics.push(
                formatDiagnostic(ruleSet, "array-index-out-of-range", lit.tok.line, lit.tok.col, {
                  num,
                  arrayName: arrayTok.text,
                  lo,
                  hi,
                  dim: dim + 1,
                })
              );
            }
          }
        } else if (!cur.isPunct(",") && !cur.isPunct("]")) {
          // An index that isn't a bare literal (a variable, or an
          // expression like `#i + 1`) is consumed but NOT flagged.
          //
          // composition-rules.yaml's `array.index.actualParameterRule` says a
          // variable expression isn't a legal index, and this used to report
          // it as an error. That was wrong for SCL: a compiling S7-1500
          // project indexes arrays with `#i + #lowerBound - 1` and similar in
          // several places. The rule's own key names the ACTUAL-PARAMETER
          // context it was transcribed from, and the fixture that "confirmed"
          // it carried a `validate against TIA compiler` caveat that was
          // never discharged -- so the confirmation was circular. See that
          // rule's own corrected note.
          while (!cur.isPunct(",") && !cur.isPunct("]") && !cur.atEnd()) {
            text += cur.next().text;
          }
        }
      }
      dim++;
      if (cur.isPunct(",")) text += cur.next().text;
    }
    if (cur.isPunct("]")) text += cur.next().text;
    return text;
  }

  /**
   * The local-tag head at peek-offset `offset`, or undefined if there isn't
   * one. Pure lookahead. Two spellings of the same thing:
   *
   *   - `#Tag` -- one ident token;
   *   - `#"Tag"` -- TWO tokens, because a name that isn't a legal bare
   *     identifier (starting with a digit, colliding with a reserved word,
   *     containing punctuation) has to be quoted, and the lexer can only
   *     read `#` as an identifier start, never as part of the quoted name.
   *
   * Recognising only the first spelling made a quoted local tag parse as a
   * bare `#` followed by an unrelated string -- which then matched the
   * `"Name".member` EXTERNAL-reference shape and was reported as a missing
   * workspace block, and hid the `#"Inst".Instruction(...)` call shape
   * entirely.
   */
  function peekLocalTagHead(offset = 0): { name: string; span: number; bare?: boolean } | undefined {
    const t0 = cur.peek(offset);
    if (t0.kind !== "ident") return undefined;
    if (!t0.text.startsWith("#")) {
      // The `#`-less spelling of the exact same reference, accepted inside
      // an SCL body for any tag THIS block declares -- see `isBareLocalTag`.
      return isBareLocalTag(t0) ? { name: t0.text, span: 1, bare: true } : undefined;
    }
    if (t0.text.length > 1) return { name: t0.text.slice(1), span: 1 };
    const t1 = cur.peek(offset + 1);
    if (t1.kind === "string" && t1.text.startsWith('"') && tokensAdjacent(t0, t1)) return { name: t1.value ?? "", span: 2 };
    return undefined;
  }

  /** Consumes `#Instance` or `wire#label` PLUS an optional single `[...]`
   * index (no `.member` chain -- that's `walkOperandRef`'s job, layered on
   * top) -- shared by `walkOperandRef` (plain operand reads) and
   * `tryWalkCall` (which needs the identical base-tag+index consumption
   * before its own `.Instruction(` call-detection, e.g.
   * `#myTimers[0].TON(...)`, without `walkOperandRef`'s dot-chain loop
   * mistakenly treating the call's instruction name as a member read). */
  function consumeBaseTagOrWire(): { topLevelName: string | null; derefTopLevelName: string | null; typeRef: TypeRef | undefined; ownerBlock: BlockInfo | undefined; interfaceOrigin: boolean; display: string; tok: Token } | undefined {
    const t0 = cur.peek();
    if (t0.kind === "string" && t0.text.startsWith('"')) {
      const globalTag = blockIndex.getGlobalTag(t0.value ?? "");
      if (globalTag) {
        const nameTok = cur.next();
        push(
          nameTok,
          "variable",
          typeRefCapabilities(globalTag.typeRef),
          renderGlobalTagHover(globalTag),
          { file: globalTag.file, line: globalTag.line }
        );
        return {
          topLevelName: typeRefTopLevelName(globalTag.typeRef),
          derefTopLevelName: typeRefDereferencedTopLevelName(globalTag.typeRef),
          typeRef: globalTag.typeRef,
          ownerBlock: blockForTypeRef(globalTag.typeRef),
          interfaceOrigin: false,
          display: nameTok.text,
          tok: nameTok,
        };
      }
    }
    if (t0.kind === "string" && t0.text.startsWith('"') && cur.peek(1).kind === "punct" && cur.peek(1).text === ".") {
      // Siemens' own external-symbol convention -- a bare double-quoted
      // reference to a workspace block (a global DATA_BLOCK, a plain
      // FUNCTION, or an FB's own external instance DB) used as a dot-chain
      // BASE, mirroring parser/s7dclParser.ts's own `looksLikeExternalRefStart`/
      // `peekExternalRefChain`. Only treated as a reference here when
      // followed by `.` -- see that function's own comment on
      // disambiguating this from an ordinary double-quoted WSTRING
      // literal (a bare quoted value with no following dot falls through
      // to `consumeLiteralValue`'s plain string-literal handling instead).
      const nameTok = cur.next();
      const extName = nameTok.value ?? "";
      const ownerBlock = blockIndex.get(extName);
      const hover = renderExternalBlockHover(extName, ownerBlock);
      push(
        nameTok,
        externalRefTokenType(ownerBlock),
        blockValueCapabilities(ownerBlock),
        hover,
        ownerBlock ? { file: ownerBlock.file, line: ownerBlock.declLine } : undefined
      );
      return { topLevelName: ownerBlock?.name ?? null, derefTopLevelName: null, typeRef: undefined, ownerBlock, interfaceOrigin: false, display: nameTok.text, tok: nameTok };
    }
    if (t0.kind === "ident" && t0.text.toLowerCase() === "wire" && tokensAdjacent(t0, cur.peek(1)) && cur.peek(1).kind === "ident" && cur.peek(1).text.startsWith("#")) {
      const wireTok = cur.next();
      const labelTok = cur.next();
      pushRun(wireTok, wireTok.text.length + labelTok.text.length, "label", []);
      // A wire# branch tap always carries a boolean RLO signal in FBD/LAD.
      return {
        topLevelName: "Bool",
        derefTopLevelName: null,
        typeRef: { kind: "named", name: "Bool", quoted: false, namespace: null },
        ownerBlock: undefined,
        interfaceOrigin: false,
        display: wireTok.text + labelTok.text,
        tok: wireTok,
      };
    }
    const localHead = peekLocalTagHead();
    if (localHead) {
      const nameTok = cur.next();
      let headLength = nameTok.text.length;
      // The quoted spelling is two tokens (`#` + `"Name"`); consume the
      // second so the semantic-token run and `display` cover the whole
      // reference rather than stopping after the `#`.
      if (localHead.span === 2) headLength += cur.next().text.length;
      const varName = localHead.name;
      const decl = findLocalDecl(varName);
      const shown = localHead.bare ? varName : `#${varName}`;
      pushRun(
        nameTok,
        headLength,
        localTagTokenType(decl),
        localDeclCapabilities(decl),
        decl ? `**${shown}** : \`${decl.typeText}\`` : undefined,
        decl ? { line: decl.line, col: decl.col } : undefined,
        decl ? memberRenameKey(decl.name, decl.section) : undefined
      );

      let ownerBlock: BlockInfo | undefined = decl ? blockIndex.get(decl.leafName ?? "") : undefined;
      let topLevelName: string | null = decl?.topLevelName ?? null;
      let derefTopLevelName: string | null = decl?.derefTopLevelName ?? null;
      let effectiveTypeRef = decl?.typeRef;
      let display = shown;

      // Dereference operator directly on the base tag: `#myRef^` -- the
      // effective type for pin-checking purposes becomes whatever the
      // Reference points to, not "Reference" itself. references.yaml's
      // own dereferencing section requires the operand to actually BE a
      // reference -- `#anOrdinaryInt^` is illegal (SEM-REF-007), not just
      // silently treated as a no-op.
      if (cur.isPunct("^")) {
        const caretTok = cur.next();
        push(caretTok, "operator", []);
        display += "^";
        if (topLevelName === "Reference") {
          topLevelName = derefTopLevelName;
          if (effectiveTypeRef?.kind === "reference") effectiveTypeRef = effectiveTypeRef.of;
        } else if (topLevelName) {
          diagnostics.push(formatDiagnostic(ruleSet, "reference-dereference-non-reference", caretTok.line, caretTok.col, { typeName: topLevelName }));
        }
      }

      if (cur.isPunct("[")) {
        display += consumeArrayIndex(nameTok, decl?.arrayBounds ?? null);
        if (topLevelName === "Array") {
          // Indexed into it -- the effective type from here on is the
          // ELEMENT type, and (if the element is a user FB/UDT) member
          // access should resolve against ITS block, not the array's own.
          topLevelName = decl?.elementTopLevelName ?? null;
          ownerBlock = blockIndex.get(decl?.elementLeafName ?? "");
          derefTopLevelName = null;
          if (effectiveTypeRef?.kind === "array") effectiveTypeRef = effectiveTypeRef.of;
        } else if (topLevelName === "String" || topLevelName === "WString") {
          // slice-access.md's separate single-character grammar:
          // `MyString[2]` -- NOT the same mechanism as ARRAY indexing
          // (String isn't 8/16/32 bits to begin with), no confirmed index
          // bounds to check (1-indexed per the one worked example, upper
          // bound unconfirmed) -- just types the result as Char/WChar.
          topLevelName = topLevelName === "String" ? "Char" : "WChar";
          derefTopLevelName = null;
          effectiveTypeRef = { kind: "named", name: topLevelName, quoted: false, namespace: null };
        }
      }

      return { topLevelName, derefTopLevelName, typeRef: effectiveTypeRef, ownerBlock, interfaceOrigin: isInterfaceDecl(decl), display, tok: nameTok };
    }
    return undefined;
  }

  /** `#Instance(.Member)*`, each segment optionally `[index]`ed and/or
   * `^`-dereferenced -- a plain tag read, a qualified read of another
   * instance's output (`#fbMvA.q_xBlockStart`), an array element
   * (`#myArr[0]`), or (when immediately followed by `(`, handled by the
   * caller before this is reached) the callee half of a call. Also
   * handles `wire#label` branch markers. */
  function walkOperandRef(): { topLevelName: string | null; display: string; tok: Token } | undefined {
    const base = consumeBaseTagOrWire();
    if (!base) return undefined;
    let ownerBlock = base.ownerBlock;
    let topLevelName = base.topLevelName;
    let derefTopLevelName = base.derefTopLevelName;
    let currentTypeRef = base.typeRef;
    const interfaceOrigin = base.interfaceOrigin;
    let display = base.display;
    const nameTok = base.tok;

    while (cur.isPunct(".")) {
        // A member name is normally a plain ident, but Siemens QUOTES any
        // member whose name isn't a legal bare identifier -- one starting
        // with a digit, or colliding with a reserved word. Both spellings
        // address the same member, so the quoted form is accepted here and
        // unquoted (via `Token.value`) before any lookup, matching how
        // `parseVarMember` already stores the declaration side. Without this
        // the dot-chain broke at the quote and left the rest of the chain to
        // be re-read as separate arguments.
        const afterDot = cur.peek(1);
        const hasPercentSlicePrefix =
          afterDot.kind === "punct" && afterDot.text === "%" && isSliceSelectorToken(cur.peek(2));
        const nextTok = cur.peek(hasPercentSlicePrefix ? 2 : 1);
        const isQuotedMember = nextTok.kind === "string" && nextTok.text.startsWith('"');
        if (nextTok.kind !== "ident" && !isQuotedMember) break;
        cur.next(); // the `.`
        const percentTok = hasPercentSlicePrefix ? cur.next() : undefined;
        const memberTok = cur.next();
        const memberName = isQuotedMember ? memberTok.value ?? "" : memberTok.text;
        const accessTok: Token = percentTok
          ? { ...memberTok, text: percentTok.text + memberTok.text, col: percentTok.col, offset: percentTok.offset }
          : memberTok;
        const displayMemberName = percentTok ? percentTok.text + memberTok.text : memberTok.text;
        display += `.${displayMemberName}`;
        let hover: string | undefined;
        let definition: Location | undefined;
        let nextTopLevelName: string | null = null;
        let nextDerefTopLevelName: string | null = null;
        let nextTypeRef: TypeRef | undefined;
        let memberCapabilities: string[] = [];
        let resolvedAsSlice = false;

        let memberRenameKeyForDot: string | undefined;
        if (ownerBlock) {
          // An INSTANCE DATA_BLOCK owns no VAR members: its members come from
          // whatever it instances -- a FUNCTION_BLOCK's interface, or an
          // instruction's pins. Resolving through to that source makes
          // `"Pump_DB".q_y` / `"R_TRIG_DB".Q` behave like `#inst.member`,
          // instead of reporting every member as "not found on" the DB.
          const memberSource = instanceTargetBlock(ownerBlock) ?? ownerBlock;
          const memberVar = memberSource.vars.get(memberName) ?? [...memberSource.vars.values()].find((entry) => entry.name.toLowerCase() === memberName.toLowerCase());
          const pinMember = memberVar ? undefined : instanceDbInstructionMember(ownerBlock, memberName);
          if (memberVar) {
            hover = `**.${memberName}** : \`${typeRefToText(memberVar.member.typeRef)}\`  \n_(${memberVar.section} of ${memberSource.name})_`;
            definition = { file: memberSource.file, line: memberVar.member.line ?? memberSource.declLine };
            nextTopLevelName = typeRefTopLevelName(memberVar.member.typeRef);
            nextDerefTopLevelName = typeRefDereferencedTopLevelName(memberVar.member.typeRef);
            nextTypeRef = memberVar.member.typeRef;
            memberCapabilities = typeRefCapabilities(memberVar.member.typeRef);
            if (isExternallyReachable(memberSource.blockType, memberVar.section)) {
              memberRenameKeyForDot = `member:${memberSource.name}:${memberName}`;
            }
          } else if (pinMember) {
            const types = pinMember.dataTypes.length > 0 ? pinMember.dataTypes.join(" | ") : "not established";
            hover = `**.${memberName}** : \`${types}\`  \n_(${pinMember.source} instance member, via \`${ownerBlock.name}\`)_`;
            // Only a single unambiguous type can carry a further `.member`/
            // slice access -- don't guess when the registry lists several.
            if (pinMember.dataTypes.length === 1) {
              nextTopLevelName = pinMember.dataTypes[0];
              nextTypeRef = { kind: "named", name: pinMember.dataTypes[0], quoted: false, namespace: null };
              memberCapabilities = namedTypeCapabilities(pinMember.dataTypes[0]);
            }
          } else {
            hover = `**.${memberName}** — not found on \`${ownerBlock.name}\``;
          }
        } else {
          // `.%X0` is unambiguously slice syntax, never a UDT member named
          // `X0`. The non-percent `.X0` spelling remains member-first so a
          // real UDT field with that name keeps working.
          const cachedMember = hasPercentSlicePrefix ? undefined : cachedMemberType(currentTypeRef, memberName);
          if (cachedMember) {
            nextTypeRef = cachedMember.typeRef;
            nextTopLevelName = typeRefTopLevelName(cachedMember.typeRef);
            nextDerefTopLevelName = typeRefDereferencedTopLevelName(cachedMember.typeRef);
            memberCapabilities = typeRefCapabilities(cachedMember.typeRef);
            hover = `**.${memberName}** : \`${typeRefToText(cachedMember.typeRef)}\`  \n_(PLC data type member)_`;
            if (cachedMember.file && cachedMember.line) definition = { file: cachedMember.file, line: cachedMember.line };
          } else if (topLevelName) {
            // slice-access.md: `.xn`/`.bn`/`.wn` bit/byte/word slicing of an
            // elementary-typed tag -- tried before instance-member
            // resolution since a slice suffix is never a real struct/timer
            // member name.
            const sliceType = resolveSliceAccess(topLevelName, accessTok);
            if (sliceType) {
              resolvedAsSlice = true;
              hover = `**.${displayMemberName}** : \`${sliceType}\`  \n_(bit/byte/word slice of '${topLevelName}', slice-access.md)_`;
              nextTopLevelName = sliceType;
              nextTypeRef = { kind: "named", name: sliceType, quoted: false, namespace: null };
            } else if (!hasPercentSlicePrefix) {
              // Not a user FB/UDT -- try a timer/counter/edge-detection
              // SYSTEM instance type instead (e.g. `#tonX.ET`,
              // `#trigStart.Q`, `#myCtr.CV`), derived from the owning
              // instruction's own pins plus IMPLICIT_INSTANCE_MEMBERS.
              const resolved = resolveInstanceMember(topLevelName, memberName);
              if (resolved) {
                hover = `**.${memberName}** : \`${resolved.dataTypes.join("/")}\`  \n_(via ${resolved.source})_`;
                if (resolved.dataTypes.length === 1) {
                  nextTopLevelName = resolved.dataTypes[0];
                  nextTypeRef = { kind: "named", name: resolved.dataTypes[0], quoted: false, namespace: null };
                  memberCapabilities = namedTypeCapabilities(resolved.dataTypes[0]);
                }
              }
            }
          }
        }

        // Syntax is only a fallback when this pass could not resolve a type.
        // A concrete TypeRef is authoritative: `Byte[0]` does not become an
        // indexable value merely because invalid bracket syntax follows it,
        // and `Byte.%X0` is scalar slice access rather than containment.
        if (!nextTypeRef) {
          if (cur.isPunct("[")) memberCapabilities.push("s7Indexable");
          if (cur.isPunct(".") && !sliceSelectorAhead()) memberCapabilities.push("s7Container");
        }
        const isResolvedInterfaceLeaf =
          interfaceOrigin &&
          !resolvedAsSlice &&
          !hasPercentSlicePrefix &&
          Boolean(nextTypeRef) &&
          normalizedCapabilities(memberCapabilities).length === 0;
        push(
          accessTok,
          resolvedAsSlice || hasPercentSlicePrefix ? "number" : isResolvedInterfaceLeaf ? "s7InterfaceMember" : "property",
          normalizedCapabilities(memberCapabilities),
          hover,
          definition,
          memberRenameKeyForDot
        );
        topLevelName = nextTopLevelName;
        derefTopLevelName = nextDerefTopLevelName;
        currentTypeRef = nextTypeRef;
        ownerBlock = blockForTypeRef(currentTypeRef);

        if (cur.isPunct("^")) {
          const caretTok = cur.next();
          push(caretTok, "operator", []);
          display += "^";
          if (topLevelName === "Reference") {
            topLevelName = derefTopLevelName;
            if (currentTypeRef?.kind === "reference") currentTypeRef = currentTypeRef.of;
            ownerBlock = blockForTypeRef(currentTypeRef);
          } else if (topLevelName) {
            diagnostics.push(formatDiagnostic(ruleSet, "reference-dereference-non-reference", caretTok.line, caretTok.col, { typeName: topLevelName }));
          }
        }

        // An ARRAY member is indexed exactly like an array BASE tag is
        // (`"DB".Units[1]`, `"DB".A[1].B[2]`) -- only the base case was
        // handled, so the `[` of any indexed member was left for the caller
        // to choke on, and every remaining token of the chain (and often of
        // the whole argument list) cascaded into `unexpected-token`. Bounds
        // aren't checked here: those come from a LOCAL declaration, and this
        // is a member of some other block's type, which `localDecls` doesn't
        // describe -- consuming the index without validating it is the
        // "recognized, not yet checked" case, not a skipped check.
        if (cur.isPunct("[")) {
          display += consumeArrayIndex(memberTok, null);
          if (currentTypeRef?.kind === "array") {
            currentTypeRef = currentTypeRef.of;
            topLevelName = typeRefTopLevelName(currentTypeRef);
            derefTopLevelName = typeRefDereferencedTopLevelName(currentTypeRef);
          } else if (topLevelName === "String" || topLevelName === "WString") {
            topLevelName = topLevelName === "String" ? "Char" : "WChar";
            currentTypeRef = { kind: "named", name: topLevelName, quoted: false, namespace: null };
            derefTopLevelName = null;
          }
          ownerBlock = blockForTypeRef(currentTypeRef);
        }
      }
    return { topLevelName, display, tok: nameTok };
  }

  // A custom FB-instance call (`#fbPumpe(...)`, no instruction-registry
  // entry) has no `required`/`dataTypes` metadata to check against, but its
  // callee block's own VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT members ARE a real,
  // known pin list -- unlike a catalog instruction's pins, these aren't
  // optional-vs-required in the same sense, so only name/casing/direction
  // are checked here, mirroring instructionChecks.ts's unknown-pin/
  // pin-case-mismatch checks for catalog instructions.
  const FB_PIN_SECTIONS = new Set(["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"]);
  function checkFbInstancePin(nameTok: Token, pinName: string, opTok: Token, ownerBlock: BlockInfo, callName: string): void {
    const exact = ownerBlock.vars.get(pinName);
    const match = exact ?? [...ownerBlock.vars.values()].find((v) => v.name.toLowerCase() === pinName.toLowerCase());
    if (!match || !FB_PIN_SECTIONS.has(match.section)) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "unknown-pin",
          nameTok.line,
          nameTok.col,
          { pinName, callName, ownerBlock: ownerBlock.name },
          { variant: "fb-instance" }
        )
      );
      return;
    }
    if (!exact) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "pin-case-mismatch",
          nameTok.line,
          nameTok.col,
          { pinName, ownerBlock: ownerBlock.name, matchName: match.name, callName },
          { variant: "fb-instance" }
        )
      );
      return;
    }
    // VAR_IN_OUT pins pass by reference and aren't consistently wired with
    // one fixed operator across real exports seen so far -- only flag the
    // unambiguous VAR_INPUT/VAR_OUTPUT direction mismatches.
    const isOutOp = opTok.text === "=>";
    if (match.section === "VAR_OUTPUT" && !isOutOp) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "pin-direction-mismatch",
          nameTok.line,
          nameTok.col,
          { pinName, callName, ownerBlock: ownerBlock.name },
          { variant: "output-wired-in" }
        )
      );
    } else if (match.section === "VAR_INPUT" && isOutOp) {
      diagnostics.push(
        formatDiagnostic(
          ruleSet,
          "pin-direction-mismatch",
          nameTok.line,
          nameTok.col,
          { pinName, callName, ownerBlock: ownerBlock.name },
          { variant: "input-wired-out" }
        )
      );
    }
  }

  function walkCallArgs(instructionEntry: InstructionEntry | undefined, callName: string, ownerBlock: BlockInfo | undefined): void {
    cur.tryPunct("(");
    // symbolic-runtime-access.yaml's workflow.matchingArrayBounds: the
    // named instruction's two named pins must share the SAME declared
    // ARRAY bounds ("a linter-checkable structural constraint given both
    // tags' declared ARRAY bounds" -- STATUS 80B4 otherwise). Captured as
    // each pin is seen below, checked once the whole call has been walked.
    const matchingBounds = ruleSet.symbolicRuntimeAccess.workflow.matchingArrayBounds;
    let nameListBounds: [number, number][] | undefined;
    let referenceListBounds: [number, number][] | undefined;
    let nameListTok: Token | undefined;

    // Parenthesis depth WITHIN this argument list. An argument's value can
    // itself be parenthesised (`IN := (#a = #b)`) or contain a nested call
    // (`IN := ABS(#x)`), and this loop used to end at the FIRST `)` it saw
    // -- so that inner one closed the whole list and every pin after it was
    // dropped on the floor: no span, no hover, no Ctrl+click, no pin/type
    // validation. Tracked rather than modelled, matching this walker's
    // deliberately tolerant design: only the depth-0 `)` ends the list.
    let depth = 0;

    while (!cur.atEnd()) {
      if (depth === 0 && cur.isPunct(")")) break;
      if (cur.isPunct("(")) {
        depth++;
        cur.next();
        continue;
      }
      if (cur.isPunct(")")) {
        depth--;
        cur.next();
        continue;
      }
      // A pin name is quoted whenever it isn't a legal bare identifier (one
      // starting with a digit, or colliding with a reserved word) -- the same
      // rule that applies to a member name, see `walkOperandRef`. Recognising
      // only the `ident` spelling meant a quoted pin fell through to the
      // value path, where its own `:=`/`=>` was then reported as an
      // unexpected token and the rest of the argument list cascaded.
      const nameCandidate = cur.peek();
      const isQuotedName = nameCandidate.kind === "string" && nameCandidate.text.startsWith('"');
      const isNamed =
        depth === 0 &&
        (nameCandidate.kind === "ident" || isQuotedName) &&
        cur.peek(1).kind === "op" &&
        (cur.peek(1).text === ":=" || cur.peek(1).text === "=>");
      let pin: InstructionPin | undefined;
      if (isNamed) {
        const nameTok = cur.next();
        const pinName = isQuotedName ? nameTok.value ?? "" : nameTok.text;
        const opTok = cur.next(); // := or =>
        pin = instructionEntry?.pins.find((p) => p.name === pinName || p.name?.toLowerCase() === pinName.toLowerCase());
        const fbVar = ownerBlock?.vars.get(pinName);
        const hover = pin
          ? `**${nameTok.text}** (${pin.dir === "in" ? ":=" : "=>"}, ${pin.required ? "required" : "optional"})${pin.dataTypes?.length ? `\n\ntypes: ${pin.dataTypes.join(", ")}` : ""}${pin.note ? `\n\n${pin.note}` : ""}`
          : fbVar
          ? `**${nameTok.text}** : \`${typeRefToText(fbVar.member.typeRef)}\`  \n_(${fbVar.section})_`
          : undefined;
        const definition = fbVar && ownerBlock ? { file: ownerBlock.file, line: fbVar.member.line ?? ownerBlock.declLine } : undefined;
        // A catalog instruction's pin name (`pin` resolved) is fixed by
        // instruction-registry, not renameable; a custom FB's named pin IS
        // just its VAR_INPUT/VAR_OUTPUT member name, so it shares that
        // member's `member:` key exactly like the dot-access case above.
        const pinRenameKey = !pin && fbVar && ownerBlock && isExternallyReachable(ownerBlock.blockType, fbVar.section) ? `member:${ownerBlock.name}:${pinName}` : undefined;
        push(nameTok, "parameter", [], hover, definition, pinRenameKey);
        if (!instructionEntry && ownerBlock) checkFbInstancePin(nameTok, pinName, opTok, ownerBlock, callName);
      }
      if (cur.isIdent("NOT")) push(cur.next(), "operator", []); // e.g. `in3 := NOT #tag`
      // value expression -- single operand/literal in every real export seen.
      const operand = walkOperandRef();
      if (operand) {
        if (pin?.dataTypes && pin.dataTypes.length > 0 && instructionEntry) {
          const { skip, types } = expandPinDataTypes(pin.dataTypes, ruleSet);
          if (!skip) {
            const severity: LintSeverity = instructionEntry.confidence === "confirmed-compiled" ? "error" : "warning";
            reportOperandTypeMismatch(operand, types, severity, `pin '${pin.name}' on '${callName}'`);
          }
        }
        if (callName === matchingBounds.instruction && (pin?.name === matchingBounds.pins[0] || pin?.name === matchingBounds.pins[1])) {
          const tagMatch = /^#([A-Za-z_][A-Za-z0-9_]*)$/.exec(operand.display);
          const bounds = tagMatch ? localDecls.get(tagMatch[1])?.arrayBounds ?? undefined : undefined;
          if (pin.name === matchingBounds.pins[0]) {
            nameListBounds = bounds;
            nameListTok = operand.tok;
          } else {
            referenceListBounds = bounds;
          }
        }
      } else {
        const value = consumeLiteralValue(cur, ruleSet);
        if (value) {
          const { tokenType, tokenModifiers } = literalSemantics(value.rawText);
          pushRun(value.tok, value.spanLength, tokenType, tokenModifiers);
          if (pin?.dataTypes && pin.dataTypes.length > 0 && instructionEntry) {
            const { skip, types } = expandPinDataTypes(pin.dataTypes, ruleSet);
            if (!skip) {
              const severity: LintSeverity = instructionEntry.confidence === "confirmed-compiled" ? "error" : "warning";
              reportLiteralMismatch(value, types, severity, `pin '${pin.name}' on '${callName}'`);
            }
          }
          // `(` is deliberately NOT consumed here -- it's an argument value
          // that OPENS a sub-expression, and the loop top is what counts it
          // into `depth`. Swallowing it here left the depth counter at 0, so
          // the sub-expression's own `)` still ended the whole list.
        } else if (!cur.isPunct(",") && !cur.isPunct(")") && !cur.isPunct("(")) {
          // Consumed unconditionally -- this is the branch that guarantees
          // the loop always makes progress, so it must never be skipped.
          const badTok = cur.next();
          // A real argument value is always a `#tag` (walkOperandRef), a
          // literal (consumeLiteralValue), or `NOT`-prefixed -- never a
          // bare identifier -- confirmed against every real .s7dcl export
          // in the workspace before adding this check, so this is never a
          // legitimate construct the walker just doesn't model yet.
          //
          // Reported only at depth 0: INSIDE a parenthesised sub-expression
          // this walker deliberately models no grammar at all (see `depth`),
          // so an operator or comparison there isn't a defect to report.
          if (depth === 0) {
            diagnostics.push(
              formatDiagnostic(ruleSet, "unexpected-token", badTok.line, badTok.col, { tokenText: badTok.text, callName }, { variant: "call-args" })
            );
          }
        }
      }
      if (cur.isPunct(",")) {
        cur.next();
        continue;
      }
    }
    cur.tryPunct(")");

    if (nameListBounds && referenceListBounds && nameListTok && JSON.stringify(nameListBounds) !== JSON.stringify(referenceListBounds)) {
      diagnostics.push(
        formatDiagnostic(ruleSet, "resolve-symbols-bounds-mismatch", nameListTok.line, nameListTok.col, {
          instruction: matchingBounds.instruction,
          pin1: matchingBounds.pins[0],
          pin2: matchingBounds.pins[1],
          bounds1: nameListBounds.map(([l, h]) => `${l}..${h}`).join(", "),
          bounds2: referenceListBounds.map(([l, h]) => `${l}..${h}`).join(", "),
          notesSuffix: matchingBounds.notes ? `; ${matchingBounds.notes}` : "",
        })
      );
    }
  }

  /** Tries to classify a call at the current position: `Name(...)` (a
   * built-in instruction), `#Instance.Name(...)` (instance-dot call to an
   * instruction, e.g. `#tonTick.TON(`), or `#Instance(...)` (a direct call
   * of a user-defined FB instance). Returns false (consumes nothing) if
   * the current position isn't a call at all. `isSclBody` (only ever true
   * when called from `walkSclBody`) enables the SCL-only bits: a bare
   * `Name(...)` call also checks `ruleSet.sclInstructions` (see
   * `findSclInstruction`) and excludes SCL_RESERVED_KEYWORDS the same way
   * `parser/s7dclParser.ts`'s own `tryParseCall`'s `allowBareInstanceCall`
   * does -- without that exclusion, `AND (#a > #b)`/`IF (...)`/etc. inside
   * an SCL body would misparse as a call to a nonexistent instruction
   * literally named "AND"/"IF" (a RUNG body never contains these keywords
   * as text at all, so `walkRung` doesn't need the exclusion). */
  function tryWalkCall(isSclBody = false): boolean {
    const t0 = cur.peek();
    if (t0.kind === "string" && t0.text.startsWith('"') && cur.peek(1).kind === "punct" && cur.peek(1).text === "(") {
      // Siemens' own external-symbol convention: a bare double-quoted call
      // target calls a workspace FUNCTION directly by its quoted name, or
      // an FB's own external instance DB -- mirrors
      // parser/s7dclParser.ts's own `tryParseCall` addition for this same
      // shape. Reuses `walkCallArgs`'s existing custom-FB-instance pin
      // validation (`checkFbInstancePin`) when the resolved block has one,
      // same as the bare `#Instance(...)` branch below already gets.
      const nameTok = cur.next(); // "Name"
      const extName = nameTok.value ?? "";
      const referencedBlock = blockIndex.get(extName);
      // A quoted LAD/FBD call normally names the FB's external instance DB,
      // whose text declaration has no VAR_INPUT/VAR_OUTPUT members of its
      // own. Validate and resolve the named arguments against the instanced
      // FUNCTION_BLOCK interface while keeping the call target's hover and
      // definition on the DATA_BLOCK itself.
      const interfaceBlock = referencedBlock ? instanceTargetBlock(referencedBlock) ?? referencedBlock : undefined;
      const hover = renderExternalBlockHover(extName, referencedBlock);
      push(nameTok, "function", [], hover, referencedBlock ? { file: referencedBlock.file, line: referencedBlock.declLine } : undefined);
      walkCallArgs(undefined, extName, interfaceBlock);
      return true;
    }
    const callHead = peekLocalTagHead();
    if (callHead) {
      // Offsets are relative to the head, which is one token for `#Inst` and
      // two for the quoted `#"Inst"` spelling -- see `peekLocalTagHead`.
      const t1 = cur.peek(callHead.span);
      const t2 = cur.peek(callHead.span + 1);
      const t3 = cur.peek(callHead.span + 2);
      if (t1.kind === "punct" && t1.text === "." && t2.kind === "ident" && t3.kind === "punct" && t3.text === "(") {
        const instTok = cur.next(); // `#` or `#Instance`
        let instLength = instTok.text.length;
        if (callHead.span === 2) instLength += cur.next().text.length; // the quoted name
        cur.next(); // .
        const nameTok = cur.next(); // Name
        const instName = callHead.name;
        const decl = findLocalDecl(instName);
        pushRun(
          instTok,
          instLength,
          localTagTokenType(decl),
          [],
          decl ? `**${callHead.bare ? instName : `#${instName}`}** : \`${decl.typeText}\`` : undefined,
          decl ? { line: decl.line, col: decl.col } : undefined,
          decl ? memberRenameKey(decl.name, decl.section) : undefined
        );
        const entry = ruleSet.instructions[nameTok.text];
        push(nameTok, "function", entry ? ["defaultLibrary"] : [], entry ? renderInstructionHover(nameTok.text, entry) : `**${nameTok.text}** — unknown instruction (not in instruction-registry)`);
        walkCallArgs(entry, nameTok.text, undefined);
        return true;
      }
      if (t1.kind === "punct" && t1.text === "(") {
        // SCL's own bare `#Instance(...)` call shape (unlike LAD/FBD's
        // `#Instance.Name(...)`, there's no explicit instruction name here
        // -- the instance's OWN declared type supplies it). Mirrors
        // linter/sclInstructionChecks.ts's `resolveCallEntry`: resolve the
        // declared type to a real instruction-registry entry first (e.g.
        // `R_TRIG_Instance : R_TRIG;` -> instruction "R_TRIG"), falling back
        // to the plain "custom FB instance" hover only when it isn't one.
        // Kept as a small local duplicate rather than importing that
        // resolver -- sclInstructionChecks.ts already imports
        // resolveInstanceTypeToInstructionNames FROM this file, so the
        // reverse import would be circular.
        const instTok = cur.next(); // `#` or `#Instance`
        let instLength = instTok.text.length;
        if (callHead.span === 2) instLength += cur.next().text.length; // the quoted name
        const instName = callHead.name;
        const decl = findLocalDecl(instName);
        let instructionEntry: InstructionEntry | undefined;
        let registryKey: string | undefined;
        if (decl?.topLevelName) {
          const candidates = resolveInstanceTypeToInstructionNames(ruleSet, decl.topLevelName);
          const lookupName = candidates.length > 0 ? candidates[0] : decl.topLevelName;
          const found = findSclInstruction(lookupName);
          if (found) {
            instructionEntry = found;
            registryKey = lookupName;
          }
        }
        const ownerBlock = !instructionEntry && decl ? blockIndex.get(decl.leafName ?? "") : undefined;
        const hover = instructionEntry
          ? renderInstructionHover(registryKey!, instructionEntry, true)
          : decl
          ? `**${callHead.bare ? instName : `#${instName}`}** : \`${decl.typeText}\`${ownerBlock ? ` — calling this ${ownerBlock.blockType.replace(/_/g, " ").toLowerCase()} instance` : ""}`
          : undefined;
        // This occurrence is the callee expression. The same instance is a
        // variable at its declaration and in `Instance.Member`, but reads as
        // a function here, exactly like call-site highlighting in mainstream
        // languages.
        pushRun(instTok, instLength, "function", [], hover, decl ? { line: decl.line, col: decl.col } : undefined, decl ? memberRenameKey(decl.name, decl.section) : undefined);
        walkCallArgs(instructionEntry, registryKey ?? instName, ownerBlock);
        return true;
      }
      if (t1.kind === "punct" && t1.text === "[") {
        // Multi-instance array-of-FB/timer/counter call, e.g.
        // `#myTimers[0].TON(...)`. Unknown-length index means a fixed
        // lookahead offset can't find the `.Instruction(` the way the
        // plain `#Instance.Name(` case above can -- scan for the matching
        // `]` first, THEN check what follows it.
        const closeIdx = findMatchingBracketClose(cur, 1);
        if (closeIdx !== null) {
          const dot = cur.peek(closeIdx + 1);
          const nameTokLookahead = cur.peek(closeIdx + 2);
          const paren = cur.peek(closeIdx + 3);
          if (dot.kind === "punct" && dot.text === "." && nameTokLookahead.kind === "ident" && paren.kind === "punct" && paren.text === "(") {
            const base = consumeBaseTagOrWire(); // consumes `#arr[i]` (base tag + index, bounds-checked)
            if (base) {
              cur.next(); // '.'
              const nameTok = cur.next(); // instruction name
              const entry = ruleSet.instructions[nameTok.text];
              push(
                nameTok,
                "function",
                entry ? ["defaultLibrary"] : [],
                entry ? renderInstructionHover(nameTok.text, entry) : `**${nameTok.text}** — unknown instruction (not in instruction-registry)`
              );
              walkCallArgs(entry, nameTok.text, undefined);
              return true;
            }
          }
        }
      }
      return false;
    }
    if (
      t0.kind === "ident" &&
      cur.peek(1).kind === "punct" &&
      cur.peek(1).text === "(" &&
      !(isSclBody && SCL_RESERVED_KEYWORDS.has(t0.text.toUpperCase()))
    ) {
      const nameTok = cur.next();
      const entry = isSclBody ? findSclInstruction(nameTok.text) : ruleSet.instructions[nameTok.text];
      // An UNQUOTED workspace block call (`ComputeOffset(...)` rather than
      // Siemens' `"ComputeOffset"(...)` spelling) -- TIA accepts it whenever
      // the name is a legal bare identifier, and it's what makes Ctrl+click
      // land on the callee's own declaration instead of nothing at all.
      // Only consulted when the name isn't a catalog instruction, so a
      // real instruction always keeps its registry hover.
      const target = !entry && isSclBody ? blockIndex.get(nameTok.text) : undefined;
      if (target) {
        // Typed exactly like the QUOTED spelling of this same call --
        // `Helper(...)` and `"Helper"(...)` are one call, so they must read
        // alike.
        push(nameTok, "function", [], renderExternalBlockHover(nameTok.text, target), { file: target.file, line: target.declLine });
        walkCallArgs(undefined, nameTok.text, target);
        return true;
      }
      push(nameTok, "function", entry ? ["defaultLibrary"] : [], entry ? renderInstructionHover(nameTok.text, entry, isSclBody) : `**${nameTok.text}** — unknown instruction (not in instruction-registry)`);
      walkCallArgs(entry, nameTok.text, undefined);
      return true;
    }
    return false;
  }

  function walkRung(): void {
    cur.tryIdent("RUNG");
    while (!cur.isIdent("END_RUNG") && !cur.atEnd()) {
      if (cur.isPunct("{")) {
        classifyPragma();
        continue;
      }
      // tryWalkCall/walkOperandRef BEFORE classifyLiteralOrSkip: a
      // double-quoted external reference (`"Name"(...)`/`"Name".member`)
      // is ALSO a bare `string` token shape -- consumeLiteralValue treats
      // ANY string unconditionally as a plain literal, so it must not run
      // first or it would swallow the reference before either function
      // gets to look at it. Neither call consumes anything when the
      // current token isn't its own shape, so trying them first is safe.
      if (tryWalkCall()) continue;
      if (walkOperandRef()) continue;
      if (classifyLiteralOrSkip()) continue; // handles a leading NOT
      // Every token directly inside a real RUNG in the workspace resolves
      // to a call, a `#tag`/`wire#label` operand, a literal, or `NOT` --
      // confirmed against every real .s7dcl export before adding this
      // check. Anything else here is genuine garbage (a typo, a stray
      // paste), not FBD/LAD grammar this walker doesn't model yet.
      const badTok = cur.next();
      diagnostics.push(formatDiagnostic(ruleSet, "unexpected-token", badTok.line, badTok.col, { tokenText: badTok.text }, { variant: "rung" }));
    }
    if (cur.isIdent("END_RUNG")) cur.next();
    walkOperandRef(); // optional trailing wire#label naming this rung's output
  }

  function walkNetwork(): void {
    cur.tryIdent("NETWORK");
    while (!cur.isIdent("END_NETWORK") && !cur.atEnd()) {
      if (cur.isPunct("{")) {
        classifyPragma();
        continue;
      }
      if (cur.isIdent("RUNG")) {
        walkRung();
        continue;
      }
      cur.next();
    }
    if (cur.isIdent("END_NETWORK")) cur.next();
  }

  function findVarSectionKeyword(): string | null {
    if (cur.isIdent("VAR") && cur.peek(1).kind === "ident" && cur.peek(1).text.toUpperCase() === "CONSTANT") return "VAR CONSTANT";
    return VAR_SECTION_KEYWORDS.find((kw) => cur.isIdent(kw)) ?? null;
  }

  /** `{ IF: "END_IF", ... }` -- every SCL block-statement keyword that
   * needs its own nesting depth tracked while scanning a FOR loop's body
   * for the loop's OWN matching END_FOR (`checkForLoop`'s own inner scan). */
  const BLOCK_STATEMENT_CLOSERS: Record<string, string> = { IF: "END_IF", CASE: "END_CASE", FOR: "END_FOR", WHILE: "END_WHILE", REPEAT: "END_REPEAT" };

  /** The peek-offset (relative to the cursor's current, unmoved position)
   * of the first depth-0 occurrence of any ident in `keywords`, scanning
   * forward from `fromOffset` -- depth increments on `(`/`[`, decrements
   * on `)`/`]`, so a keyword textually appearing inside a parenthesized/
   * indexed sub-expression is correctly skipped over. `null` if none is
   * found before EOF or `maxScan` tokens (a generous sanity bound against
   * a malformed/unterminated construct never resolving, not a real limit
   * any legitimate FOR header should ever approach). */
  function peekFindKeywordAt(fromOffset: number, keywords: Set<string>, maxScan = 500): number | null {
    let depth = 0;
    for (let i = fromOffset; i < fromOffset + maxScan; i++) {
      const t = cur.peek(i);
      if (t.kind === "eof") return null;
      if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
      else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
      else if (depth === 0 && t.kind === "ident" && keywords.has(t.text.toUpperCase())) return i;
    }
    return null;
  }

  /** Siemens' SCL FOR reference, two rules: (1) the run variable cannot be
   * modified from inside the loop's own body; (2) the run variable/start/
   * end/BY values must all be the same signedness (never mixed signed +
   * unsigned integer types). PEEK-ONLY (see this section's own
   * `peekFindKeywordAt`) -- doesn't disturb `walkSclBody`'s own normal
   * token-by-token walk of the SAME `FOR ... END_FOR` text, which still
   * needs to happen for the loop body's own calls/refs/hover spans.
   *
   * Only checks a start/end/BY value when it's a SINGLE token (a bare
   * `#tag` or a plain literal) -- a compound expression's type isn't
   * inferred here (the fixture corpus's real expression-type engine is
   * linter/exprTypeChecks.ts, scoped to plain assignments, not a FOR
   * header) -- don't guess. A bare numeric literal also isn't typed on its
   * own (no fixed signedness without a suffix/context), only a declared
   * `#tag` operand contributes to the signed/unsigned check. */
  function checkForLoop(): void {
    let offset = 1; // "FOR" itself is at offset 0
    const varTok = cur.peek(offset);
    if (!(varTok.kind === "ident" && varTok.text.startsWith("#"))) return;
    offset++;
    if (!(cur.peek(offset).kind === "op" && cur.peek(offset).text === ":=")) return;
    offset++;

    const startOffset = offset;
    const toOffset = peekFindKeywordAt(offset, new Set(["TO"]));
    if (toOffset === null) return;

    const endOffset = toOffset + 1;
    const byOrDoOffset = peekFindKeywordAt(endOffset, new Set(["BY", "DO"]));
    if (byOrDoOffset === null) return;
    const isBy = cur.peek(byOrDoOffset).text.toUpperCase() === "BY";
    const endExprEnd = byOrDoOffset;

    let byExprStart = -1;
    let byExprEnd = -1;
    let doOffset = byOrDoOffset;
    if (isBy) {
      byExprStart = byOrDoOffset + 1;
      const found = peekFindKeywordAt(byExprStart, new Set(["DO"]));
      if (found === null) return;
      byExprEnd = found;
      doOffset = found;
    }

    // --- run variable/start/end/BY signedness -----------------------
    const loopVarName = varTok.text.slice(1);
    function singleTokenTypeName(fromOffsetIncl: number, toOffsetExcl: number): string | null {
      if (toOffsetExcl - fromOffsetIncl !== 1) return null;
      const t = cur.peek(fromOffsetIncl);
      if (t.kind !== "ident" || !t.text.startsWith("#")) return null;
      const decl = localDecls.get(t.text.slice(1));
      return decl?.topLevelName ? resolveTypeAlias(decl.topLevelName, ruleSet) : null;
    }
    const decl = localDecls.get(loopVarName);
    const candidateTypes = [
      decl?.topLevelName ? resolveTypeAlias(decl.topLevelName, ruleSet) : null,
      singleTokenTypeName(startOffset, toOffset),
      singleTokenTypeName(endOffset, endExprEnd),
      isBy ? singleTokenTypeName(byExprStart, byExprEnd) : null,
    ];
    let signedType: string | null = null;
    let unsignedType: string | null = null;
    for (const t of candidateTypes) {
      if (!t) continue;
      const signed = ruleSet.baseTypes[t]?.signed;
      if (signed === true) signedType ??= t;
      else if (signed === false) unsignedType ??= t;
    }
    if (signedType && unsignedType) {
      diagnostics.push(formatDiagnostic(ruleSet, "for-mixed-signed-unsigned", varTok.line, varTok.col, { signedType, unsignedType }));
    }

    // --- loop variable modified inside its own body ------------------
    const bodyStart = doOffset + 1;
    let depth = 0;
    for (let i = bodyStart; i < bodyStart + 5000; i++) {
      const t = cur.peek(i);
      if (t.kind === "eof") return;
      if (t.kind === "ident") {
        const upper = t.text.toUpperCase();
        if (depth === 0 && upper === "END_FOR") {
          for (let j = bodyStart; j < i; j++) {
            const bt = cur.peek(j);
            if (bt.kind === "ident" && bt.text === varTok.text && cur.peek(j + 1).kind === "op" && cur.peek(j + 1).text === ":=") {
              diagnostics.push(formatDiagnostic(ruleSet, "for-loop-variable-modified", bt.line, bt.col, { name: loopVarName }));
            }
          }
          return;
        }
        if (BLOCK_STATEMENT_CLOSERS[upper]) depth++;
        else if (Object.values(BLOCK_STATEMENT_CLOSERS).includes(upper)) depth--;
      }
    }
  }

  /** references.yaml's `assignmentAttempt.sclRestriction`: `?=` (the
   * VARIANT/DB_ANY-to-reference runtime-checked assignment operator)
   * cannot be chained (`a ?= b ?= c;`) the way a plain `:=` can. PEEK-ONLY,
   * triggered on EVERY `?=` token `walkSclBody`'s own loop reaches (it
   * doesn't otherwise recognize `?=` at all, so nothing else consumes it).
   * Reports exactly ONCE per illegal chain, at its FIRST `?=` -- a `?=`
   * that already has an EARLIER one in the same statement is skipped here
   * (it would already have been reported when the walk reached that
   * earlier one), and only a `?=` with a LATER one before the statement's
   * terminating `;` is flagged at all. */
  function checkAssignmentAttemptChaining(): void {
    let behind = -1;
    let depth = 0;
    for (;;) {
      const t = cur.peek(behind);
      if (!t || t.kind === "eof" || behind < -2000) return;
      if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth++;
      else if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth--;
      else if (depth === 0 && t.kind === "punct" && t.text === ";") break; // reached the statement's own start
      else if (depth === 0 && t.kind === "op" && t.text === "?=") return; // an EARLIER '?=' already covers this chain
      behind--;
    }

    let ahead = 1;
    depth = 0;
    for (;;) {
      const t = cur.peek(ahead);
      if (t.kind === "eof" || ahead > 2000) return;
      if (t.kind === "punct" && (t.text === "(" || t.text === "[")) depth++;
      else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) depth--;
      else if (depth === 0 && t.kind === "punct" && t.text === ";") return; // statement ends with no further '?=' -- not chained
      else if (depth === 0 && t.kind === "op" && t.text === "?=") break;
      ahead++;
    }

    const tok = cur.peek();
    diagnostics.push(formatDiagnostic(ruleSet, "reference-assignment-attempt-chained", tok.line, tok.col));
  }

  /** Walks a `BEGIN ... <endKeyword>` SCL statement body -- an authored
   * `.scl` source file's executable code, as opposed to a NETWORK/RUNG
   * LAD/FBD body (see parser/s7dclParser.ts's own `parseSclBody`, which
   * this mirrors). Unlike `walkRung`, IF/CASE/FOR/WHILE/REPEAT/REGION
   * nesting is never modeled as a tree here -- only the calls and `#tag`
   * references matter for hover/definition, so anything else is silently
   * skipped rather than flagged (a RUNG's own token set is small and fully
   * modeled, so `walkRung` can safely treat a leftover token as genuine
   * garbage; SCL's is far richer, and every skipped keyword here is normal
   * grammar, not an error). */
  function walkSclBody(endKeyword: string): void {
    cur.tryIdent("BEGIN");
    inSclBody = true; // enables the bare, `#`-less local-tag spelling -- see `isBareLocalTag`
    while (!cur.isIdent(endKeyword) && !cur.atEnd()) {
      if (cur.isPunct("{")) {
        classifyPragma();
        continue;
      }
      if (cur.isIdent("FOR")) checkForLoop(); // peek-only -- see its own header
      if (cur.isOp("?=")) checkAssignmentAttemptChaining(); // peek-only -- see its own header
      // tryWalkCall/walkOperandRef BEFORE classifyLiteralOrSkip -- see
      // walkRung's own identical comment on why (a quoted external
      // reference is also a bare `string` token shape, and
      // consumeLiteralValue would otherwise swallow it as a plain literal
      // first).
      if (tryWalkCall(true)) continue;
      if (walkOperandRef()) continue;
      if (classifyLiteralOrSkip()) continue; // handles a leading NOT
      cur.next(); // IF/THEN/CASE/FOR/WHILE/REPEAT/operators/etc. -- not modeled, not an error
    }
    inSclBody = false;
  }

  // --- top-level walk -----------------------------------------------
  // Loops over EVERY declaration in the file, not just the first -- an
  // authored `.scl` source file routinely bundles several TYPE/program-block
  // declarations in one file (confirmed against the real distributed-process-control.scl
  // corpus), unlike a `.s7dcl` export (always exactly one). Mirrors
  // parser/s7dclParser.ts's own `parseS7dclFile` outer loop. `localDecls` is
  // deliberately NOT reset between blocks -- declarations are walked
  // strictly in file order and every span already bakes in its resolved
  // value at walk time, so accumulating across blocks is safe (no
  // forward-reference is possible) and gives hover/definition one flat map
  // to resolve against. It is NOT a scope, though: `blockScopes` (recorded
  // below, one entry per declaration) is what says which tags are actually
  // addressable at a given position.
  classifyPragma(); // file-level attributes

  while (!cur.atEnd()) {
    let blockKeyword: string | null = null;
    let blockKeywordTok: Token | null = null;
    for (const kw of BLOCK_KEYWORDS) {
      if (cur.isIdent(kw)) {
        blockKeyword = kw;
        blockKeywordTok = cur.peek();
        cur.next();
        break;
      }
    }

    if (blockKeyword) {
      currentBlockType = blockKeyword;
      currentBlockName = null;
      currentBlockTags = new Map();
      const scope: BlockScope = {
        name: null,
        blockType: blockKeyword,
        startLine: blockKeywordTok?.line ?? 1,
        // Provisional: overwritten with the real END_xxx line below. A
        // declaration still being typed never reaches that, so it keeps the
        // open-ended value and stays in scope to the end of the file -- which
        // is what the user is editing inside.
        endLine: Number.MAX_SAFE_INTEGER,
        decls: currentBlockTags,
      };
      blockScopes.push(scope);
      let declaredBlockInfo: BlockInfo | undefined;
      let dataBlockInstanceTypeSeen = false;
      const dataBlockStorageDecls: LocalDecl[] = [];
      if (cur.peek().kind === "string" || cur.peek().kind === "ident") {
        const nameTok = cur.next(); // TextMate already colors the string; span pushed below is for rename/hover only
        currentBlockName = nameTok.kind === "string" ? nameTok.value ?? nameTok.text : nameTok.text;
        scope.name = currentBlockName;
        declaredBlockInfo = blockIndex.get(currentBlockName);
        // A block declaration uses the same standard role as its symbol:
        // DATA_BLOCK is storage, FUNCTION_BLOCK is an instantiable class-like
        // type, and FUNCTION/OB are executable functions.
        const declaredBlockTokenType =
          blockKeyword === "DATA_BLOCK"
            ? externalRefTokenType(declaredBlockInfo)
            : blockKeyword === "FUNCTION_BLOCK"
              ? "s7CallableType"
              : "function";
        push(
          nameTok,
          declaredBlockTokenType,
          ["declaration", ...(blockKeyword === "DATA_BLOCK" ? ["s7Container"] : [])],
          typeHover(currentBlockName),
          undefined,
          `type:${currentBlockName}`
        );
      }
      // `FUNCTION "Name" : <returnType>` -- the only block header with a
      // type in it. Walked (rather than skipped as it used to be) so the
      // return type is coloured like the type it is, by the same
      // `typeNameSemantics` every other type occurrence goes through.
      if (blockKeyword === "FUNCTION" && cur.isPunct(":")) {
        cur.next();
        walkTypeRef("VAR");
      }
      classifyPragma(); // block-level attributes

      const endKeyword = `END_${blockKeyword}`;
      while (!cur.isIdent(endKeyword) && !cur.atEnd()) {
        // A typed/instance DATA_BLOCK has a second type name in its header:
        // `DATA_BLOCK "Fb_Unit_DB" "Fb_Unit"`. The block parser/index has
        // already disambiguated that token from VERSION/TITLE/etc., so match
        // the indexed `instanceOf` here instead of guessing from quote shape.
        // This makes the DB declaration an instance value and the second name
        // its UDT/FB/instruction type rather than leaving both as strings.
        const instanceOf = declaredBlockInfo?.instanceOf;
        if (blockKeyword === "DATA_BLOCK" && instanceOf && !dataBlockInstanceTypeSeen) {
          const candidate = cur.peek();
          const candidateName = candidate.kind === "string" ? candidate.value ?? candidate.text : candidate.kind === "ident" ? candidate.text : undefined;
          const quoteShapeMatches = instanceOf.quoted ? candidate.kind === "string" && candidate.text.startsWith('"') : candidate.kind === "ident";
          if (candidateName?.toLowerCase() === instanceOf.name.toLowerCase() && quoteShapeMatches) {
            pushTypeNameSpan(candidate, candidateName, candidate.text.length);
            cur.next();
            dataBlockInstanceTypeSeen = true;
            continue;
          }
        }

        // A global DATA_BLOCK may express its own storage as an anonymous
        // outer STRUCT rather than VAR...END_VAR. Its DIRECT children are
        // still top-level DB properties; nested inline Struct members remain
        // nested fields through walkTypeRef's existing recursive handling.
        if (blockKeyword === "DATA_BLOCK" && cur.isIdent("STRUCT")) {
          const structTok = cur.next();
          push(structTok, "struct", ["defaultLibrary"]);
          const previousSection: string | null = currentSectionKind;
          currentSectionKind = "VAR";
          while (!cur.isIdent("END_STRUCT") && !cur.isIdent(endKeyword) && !cur.atEnd()) {
            const member = walkVarMember("VAR");
            if (member) dataBlockStorageDecls.push(member);
          }
          if (cur.isIdent("END_STRUCT")) push(cur.next(), "struct", ["defaultLibrary"]);
          cur.tryPunct(";");
          currentSectionKind = previousSection;
          continue;
        }

        const varKw = findVarSectionKeyword();
        if (varKw) {
          cur.next();
          if (varKw === "VAR CONSTANT") cur.next(); // consume "CONSTANT" too
          currentSectionKind = varKw === "VAR CONSTANT" ? "VAR_CONSTANT" : varKw;
          while (!cur.isIdent("END_VAR") && !cur.atEnd()) {
            const member = walkVarMember("VAR");
            if (member && blockKeyword === "DATA_BLOCK") dataBlockStorageDecls.push(member);
          }
          if (cur.isIdent("END_VAR")) cur.next();
          currentSectionKind = null;
          continue;
        }
        if (cur.isPunct("{")) {
          classifyPragma();
          if (cur.isIdent("NETWORK")) walkNetwork();
          continue;
        }
        if (cur.isIdent("NETWORK")) {
          walkNetwork();
          continue;
        }
        if (cur.isIdent("BEGIN")) {
          // linter/sclInstructionChecks.ts + linter/symbolChecks.ts already
          // run their own complete diagnostics over every SCL call/operand/
          // condition in every block (wired in separately via
          // extension.ts's lintDocument, using parseS7dclFile). Reusing
          // tryWalkCall/walkCallArgs/walkOperandRef here for their SPANS
          // (hover/definition) would also re-trigger their DIAGNOSTICS
          // side effect -- swap in a throwaway array for the duration so
          // only the spans survive by default.
          //
          // EXCEPT: array-index-expression/array-index-out-of-range
          // (consumeArrayIndex, reached via walkOperandRef) are THIS
          // module's OWN exclusive concern -- no other check anywhere
          // duplicates an array-index bounds/shape validation for an SCL
          // body statement (unlike a RUNG-based LAD/FBD file, where
          // walkRung's own diagnostics were never suppressed like this in
          // the first place). Confirmed via the scl-diagnostics manifest's SEM-ARRAY-005
          // fixture: `#values[#i + 1] := 10;` silently produced ZERO
          // diagnostics before this carve-out, purely because it happened
          // to run inside a BEGIN body -- the exact same construct inside
          // consumeArrayIndex works fine when reached from a VAR-section
          // declaration walk instead. Whitelisted by code rather than
          // flipping the default, so a FUTURE diagnostic added to this
          // walk still defaults to suppressed (safe) unless deliberately
          // added here.
          const savedDiagnostics = diagnostics;
          diagnostics = [];
          walkSclBody(endKeyword);
          const SURVIVES_SCL_BODY_DISCARD = new Set([
            "array-index-expression",
            "array-index-out-of-range",
            "for-loop-variable-modified",
            "for-mixed-signed-unsigned",
            "reference-dereference-non-reference",
            "reference-assignment-attempt-chained",
          ]);
          for (const d of diagnostics) {
            if (SURVIVES_SCL_BODY_DISCARD.has(d.code)) savedDiagnostics.push(d);
          }
          diagnostics = savedDiagnostics;
          continue;
        }
        cur.next();
      }
      // The loop exits ON the `END_xxx` token (never consumed here -- the
      // outer loop's own defensive skip steps past it), or at EOF for a
      // declaration that isn't closed yet.
      if (blockKeyword === "DATA_BLOCK") {
        const optimized = declaredBlockInfo?.optimizedAccess;
        applyMemberStorageHovers(
          dataBlockStorageDecls,
          "data-block member",
          optimized === true ? "Siemens standard transfer" : "Siemens standard / non-optimized",
          optimized === true
            ? "This is the standard-transfer offset. The physical optimized offset is target-system dependent and may differ."
            : optimized === undefined
              ? "Access mode is not declared; this is the deterministic standard/non-optimized offset."
              : undefined
        );
      }
      if (cur.isIdent(endKeyword)) scope.endLine = cur.peek().line;
      continue;
    }

    if (cur.isIdent("TYPE")) {
      // .udt / TYPE-block file: `TYPE "Name" VERSION : x.y STRUCT ... END_STRUCT; END_TYPE`.
      cur.next();
      const udtMembers: LocalDecl[] = [];
      if (cur.peek().kind === "string" || cur.peek().kind === "ident") {
        // A UDT's own name uses the same custom struct subtype as every
        // reference to it, allowing themes/users to distinguish PLC data
        // types without losing normal `struct` fallback styling.
        // already is -- it had no span at all before, so a PLC data type
        // declaration read as plain text while its uses read as a type.
        const udtNameTok = cur.next();
        const udtName = udtNameTok.kind === "string" ? udtNameTok.value ?? udtNameTok.text : udtNameTok.text;
        const cachedUdt = typeCache ? lookupType(typeCache, udtName) : undefined;
        const canonicalName = cachedUdt?.kind === "udt" ? cachedUdt.name : udtName;
        push(udtNameTok, "s7UdtType", ["declaration"], typeHover(udtName), undefined, `udt:${canonicalName}`);
      }
      if (cur.isIdent("VERSION")) {
        cur.next();
        while (!cur.isIdent("STRUCT") && !cur.atEnd()) cur.next();
      }
      if (cur.isIdent("STRUCT")) {
        push(cur.next(), "struct", ["defaultLibrary"]);
        while (!cur.isIdent("END_STRUCT") && !cur.atEnd()) {
          const member = walkVarMember("STRUCT");
          if (member) udtMembers.push(member);
        }
        if (cur.isIdent("END_STRUCT")) push(cur.next(), "struct", ["defaultLibrary"]);
      }
      applyMemberStorageHovers(udtMembers, "UDT member", "Siemens standard / non-optimized");
      cur.tryIdent("END_TYPE");
      continue;
    }

    // Neither a block nor a TYPE declaration -- stray/malformed top-level
    // content. Skip one token to guarantee progress and keep looking for
    // the next declaration (mirrors parseS7dclFile's own defensive skip).
    cur.next();
  }

  return { spans, diagnostics, localDecls, blockScopes };
}

/** The block declaration containing 1-based `line`, or undefined when the
 * position sits between declarations (where no local tag is addressable).
 * Searched last-first so an unclosed declaration being typed -- whose
 * `endLine` is open-ended -- doesn't swallow positions inside the closed
 * blocks before it. */
export function blockScopeAt(index: DocumentIndex, line: number): BlockScope | undefined {
  for (let i = index.blockScopes.length - 1; i >= 0; i--) {
    const scope = index.blockScopes[i];
    if (line >= scope.startLine && line <= scope.endLine) return scope;
  }
  return undefined;
}
