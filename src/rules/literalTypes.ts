// Classifies a raw .s7dcl literal's TEXT (e.g. `4`, `4.0`, `'A'`, `"txt"`,
// `T#10S`, `16#FF`, `B#16#0F`, `P#DB10.DBX20.0`) against base-types.yaml's
// numberRepresentations, so a lint rule can check a VAR default value or an
// instruction pin's literal argument against its declared/expected type.
// Deliberately conservative: an unrecognized literal shape returns `null`
// ("don't know, don't guess" -- same discipline instruction-registry/README.md
// applies to unfilled `dataTypes`), never a false "doesn't match".
import { BaseTypeEntry, RuleSet } from "./types";

function stripDigitSeparators(s: string): string {
  return s.replace(/_/g, "");
}

function decimalFormRanges(type: BaseTypeEntry): { min: number; max: number }[] {
  return (type.numberRepresentations ?? [])
    .filter((r) => (r.form === "signed-integer" || r.form === "unsigned-integer") && typeof r.min === "number" && typeof r.max === "number")
    .map((r) => ({ min: r.min as number, max: r.max as number }));
}

/** Bare decimal literal (`4`, `-63`) -- checked against each type's OWN
 * documented decimal-form range(s). Bool is special-cased: its "0 or 1"
 * range is free text in the yaml (no structured min/max), unlike every
 * other type here. */
function acceptsDecimal(type: BaseTypeEntry, value: number): boolean {
  if (type.category === "bit") return value === 0 || value === 1;
  const ranges = decimalFormRanges(type);
  return ranges.some((r) => value >= r.min && value <= r.max);
}

/** Categories where a bare radix literal (no letter size-prefix) is a
 * documented bit-pattern notation at all -- float/duration/date-time/
 * character/string/system/complex types have their own dedicated (and, for
 * Char/WChar, single-quoted) literal syntax instead; a bare `16#FF` is
 * never valid for e.g. Real or Char even though the value would fit their
 * storage width. */
const RADIX_ELIGIBLE_CATEGORIES = new Set(["bit", "bit-string", "integer-signed", "integer-unsigned"]);

/** Radix literal (`16#FF`, `2#0101`, `8#377`) -- these encode a raw bit
 * pattern, not a signed decimal value, so (per base-types.yaml's own
 * examples, e.g. SInt's "16#50" alongside its "+50" decimal example) any
 * numeric type whose storage width can hold the value accepts it,
 * regardless of signed/unsigned category. */
function acceptsRadixValue(type: BaseTypeEntry, value: number): boolean {
  if (type.sizeBits == null || value < 0 || !RADIX_ELIGIBLE_CATEGORIES.has(type.category)) return false;
  return value <= Math.pow(2, type.sizeBits) - 1;
}

interface ParsedRadixLiteral {
  sizeHint: "B" | "W" | "DW" | null;
  value: number;
}

/** A fully typed constant's `<DataType>#` prefix -- the S7-SCL "Notation
 * for Constants" grammar (SIMATIC S7-SCL V5.3 manual A5E00324650-01,
 * 9.1.3.1-9.1.3.4) lets an elementary type name spell out what the `B#`/
 * `W#`/`DW#` short forms abbreviate, and stack a radix prefix on top of
 * it: `BYTE#2#1111_0000`, `WORD#8#177777`, `INT#16#3f_ff`, `int#-32768`,
 * `BOOL#TRUE`, `char#'B'`, `real#1.5`. See parser/literalRun.ts for the
 * full prefix list and the token-level handling.
 *
 * Used for SHAPE detection only -- `classifyLiteral` deliberately does NOT
 * resolve these to their named type, see its own comment. */
const TYPED_CONSTANT_PREFIX_RE = /^(BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|CHAR|WCHAR)#/i;

/** `16#FF` / `2#0101` / `8#377` / `B#16#0F` / `W#16#F1C0` / `DW#16#20_F30A`. */
function parseRadixLiteral(text: string): ParsedRadixLiteral | null {
  const m = /^(B|W|DW)?#?(\d+)#([0-9A-Fa-f_]+)$/i.exec(text);
  if (!m) return null;
  const base = parseInt(m[2], 10);
  if (base !== 2 && base !== 8 && base !== 16) return null;
  const value = parseInt(stripDigitSeparators(m[3]), base);
  if (Number.isNaN(value)) return null;
  return { sizeHint: (m[1]?.toUpperCase() as "B" | "W" | "DW" | undefined) ?? null, value };
}

const DATE_TIME_PREFIXES: [RegExp, string][] = [
  [/^DTL#/i, "DTL"],
  [/^LTOD#/i, "LTime_Of_Day"],
  [/^(TOD|TIME_OF_DAY)#/i, "Time_Of_Day"],
  [/^(DT|DATE_AND_TIME)#/i, "Date_And_Time"],
  [/^(D|DATE)#/i, "Date"],
];

const DURATION_PREFIXES: [RegExp, string][] = [
  [/^(S5T|S5TIME)#/i, "S5Time"],
  [/^(LT|LTIME)#/i, "LTime"],
  [/^(T|TIME)#/i, "Time"],
];

const DATE_BARE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;

// base-types.yaml's `addressExamples` -- absolute/direct-address operand
// forms, optionally `%`-prefixed (the modern TIA spelling). Ambiguous
// candidate sets mirror the yaml: e.g. Byte/SInt/USInt genuinely share the
// same "IB2"/"MB10"/"DB1.DBB4" address shape (Byte's own addressExamples
// list and SInt's "Shares its address range with USInt/Byte" note).
const AREA_BIT_RE = /^%?(I|Q|M)\d+\.\d+$/i;
const AREA_BYTE_RE = /^%?(I|Q|M)B\d+$/i;
const AREA_WORD_RE = /^%?(I|Q|M)W\d+$/i;
const AREA_DWORD_RE = /^%?(I|Q|M)D\d+$/i;
const DB_BIT_RE = /^%?DB\d+\.DBX\d+\.\d+$/i;
const DB_BYTE_RE = /^%?DB\d+\.DBB\d+$/i;
const DB_WORD_RE = /^%?DB\d+\.DBW\d+$/i;
const DB_DWORD_RE = /^%?DB\d+\.DBD\d+$/i;

/** Classifies an absolute/direct-address operand's text (not a value
 * literal -- an addressed memory reference), e.g. `%I0.0`, `MW10`,
 * `DB1.DBX2.3`. Returns `null` (not an address shape at all) rather than
 * an empty Set when nothing matches, same "don't guess" contract as
 * `classifyLiteral`. */
export function classifyAddressText(text: string): Set<string> | null {
  if (AREA_BIT_RE.test(text) || DB_BIT_RE.test(text)) return new Set(["Bool"]);
  if (AREA_BYTE_RE.test(text) || DB_BYTE_RE.test(text)) return new Set(["Byte", "SInt", "USInt"]);
  if (AREA_WORD_RE.test(text) || DB_WORD_RE.test(text)) return new Set(["Word", "Int", "UInt"]);
  if (AREA_DWORD_RE.test(text) || DB_DWORD_RE.test(text)) return new Set(["DWord", "DInt", "UDInt", "Real"]);
  return null;
}

/** any-pointer.yaml's `dataTypeCodes` table -- the legacy/STL-style type
 * names legal in an ANY pointer's `P#<address> Type Number` trailing
 * suffix (`NIL` excluded here: it names the null-pointer encoding, not a
 * selectable literal type -- the YAML table itself keeps NIL, since it's
 * still a real code, just not one this particular check should match).
 * This is the ONLY thing that disambiguates an `Any` P#-literal from a
 * `Pointer` one -- pointer-type.yaml's P#-literal grammar has no such
 * suffix at all, ever. Derived from the loaded registry (not hardcoded)
 * so an added/corrected data-type code doesn't need a matching code edit. */
export function anyDataTypeCodeNames(ruleSet: RuleSet): Set<string> {
  const names = new Set<string>();
  for (const code of Object.values(ruleSet.anyPointer.dataTypeCodes)) {
    if (code.name !== "NIL") names.add(code.name);
  }
  return names;
}

/** The literal keyword(s) that resolve to a zero-value/unassigned instance
 * of Any (`any-pointer.yaml`'s `structure.zeroPointer.ladFbdLiteral`),
 * Reference (`references.yaml`'s `initialization.default`), and Pointer
 * (`pointer-type.yaml`'s `pointerKinds[].zeroLiteral`) -- three DIFFERENT
 * legacy/typed-pointer-ish constructs that happen to each have their own
 * zero-value spelling (confirmed NOT interchangeable: Any/Reference share
 * "NULL", Pointer uses "ZERO" instead). Derived from the loaded registry
 * so the actual keyword lives in exactly one place. */
function zeroValueLiteralTypes(text: string, ruleSet: RuleSet): Set<string> {
  const upper = text.toUpperCase();
  const types = new Set<string>();
  if (upper === ruleSet.anyPointer.structure.zeroPointer.ladFbdLiteral.toUpperCase()) types.add("Any");
  if (upper === ruleSet.references.initialization.default.toUpperCase()) types.add("Reference");
  const pointerZeroLiteral = ruleSet.pointerType.pointerKinds.find((k) => k.zeroLiteral)?.zeroLiteral;
  if (pointerZeroLiteral && upper === pointerZeroLiteral.toUpperCase()) types.add("Pointer");
  return types;
}

/**
 * Returns the set of base-types.yaml type names `raw` could legally
 * initialize/assign, or `null` if the text isn't a literal shape this
 * classifier recognizes at all (e.g. a bare identifier referencing another
 * constant) -- callers must treat `null` as "skip validation," not as "no
 * match." An empty (non-null) Set means "recognized as a literal, but no
 * declared elementary type accepts it" -- a genuine mismatch.
 */
export function classifyLiteral(raw: string, ruleSet: RuleSet): Set<string> | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  if (/^(TRUE|FALSE)$/i.test(text)) return new Set(["Bool"]);
  // NULL is Any's LAD/FBD zero-pointer literal (any-pointer.yaml) AND a
  // Reference's unassigned/default value and only legal comparison target
  // (references.yaml's `initialization.default` / `comparison`) -- the
  // same literal text is valid for either declared type. ZERO is Pointer's
  // OWN, different zero-value spelling (pointer-type.yaml) -- the three
  // legacy/typed-pointer-ish constructs don't share one keyword.
  const zeroTypes = zeroValueLiteralTypes(text, ruleSet);
  if (zeroTypes.size > 0) return zeroTypes;

  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return new Set(["WString"]);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    const content = text.slice(1, -1);
    return content.length === 1 ? new Set(["Char", "WChar", "String"]) : new Set(["String"]);
  }

  if (/^P#/i.test(text)) {
    // Any's own P#-literal grammar (any-pointer.yaml) ALWAYS carries a
    // trailing `Type Number` pair (e.g. `P#M20.0 BYTE 10`); Pointer's
    // (pointer-type.yaml) never does -- this fully disambiguates the two
    // legacy pointer types' otherwise-identical `P#<address>` prefix, so a
    // bare address is Pointer-only, and a recognized suffix is Any-only.
    const suffixMatch = /^P#\S+\s+([A-Za-z_]+)\s+(\d+)$/.exec(text);
    if (suffixMatch && anyDataTypeCodeNames(ruleSet).has(suffixMatch[1].toUpperCase())) return new Set(["Any"]);
    return new Set(["Pointer"]);
  }

  for (const [re, typeName] of DATE_TIME_PREFIXES) if (re.test(text)) return new Set([typeName]);
  for (const [re, typeName] of DURATION_PREFIXES) if (re.test(text)) return new Set([typeName]);
  if (DATE_BARE_RE.test(text)) return new Set(["Date"]);

  // A fully typed constant (`BYTE#2#1111_0000`, `WORD#8#177777`,
  // `INT#-32768`) falls through to `null` on purpose -- "recognized, but
  // don't validate," not an oversight. Siemens' own rule is that the
  // prefix names a MINIMUM, not an exact match: "a Word tag permits the
  // usage of byte or word constants, such as BYTE#2 or WORD#2", so
  // resolving `BYTE#2` to just {Byte} would flag a perfectly legal
  // assignment to a Word. Pinning down the exact widening lattice needs
  // more than base-types.yaml currently records, and this module's
  // contract is to skip rather than guess. (The `B#`/`W#`/`DW#` short
  // forms below predate this note and DO resolve to one type -- narrower
  // than Siemens allows, but long-standing and fixture-covered.)
  if (TYPED_CONSTANT_PREFIX_RE.test(text)) return null;

  const radix = parseRadixLiteral(text);
  if (radix) {
    if (radix.sizeHint) {
      const target = radix.sizeHint === "B" ? "Byte" : radix.sizeHint === "W" ? "Word" : "DWord";
      const type = ruleSet.baseTypes[target];
      return type && acceptsRadixValue(type, radix.value) ? new Set([target]) : new Set<string>();
    }
    const matches = new Set<string>();
    for (const [name, type] of Object.entries(ruleSet.baseTypes)) {
      if (acceptsRadixValue(type, radix.value)) matches.add(name);
    }
    return matches;
  }

  if (/^[+-]?\d[\d_]*$/.test(text)) {
    const value = parseInt(stripDigitSeparators(text), 10);
    const matches = new Set<string>();
    for (const [name, type] of Object.entries(ruleSet.baseTypes)) {
      if (acceptsDecimal(type, value)) matches.add(name);
    }
    return matches;
  }

  if (/^[+-]?\d[\d_]*(\.\d+)?[eE][+-]?\d+$/.test(text) || /^[+-]?\d[\d_]*\.\d+$/.test(text)) {
    const matches = new Set<string>();
    for (const [name, type] of Object.entries(ruleSet.baseTypes)) {
      if (type.category === "float") matches.add(name);
    }
    return matches;
  }

  const address = classifyAddressText(text);
  if (address) return address;

  return null;
}

/** Coarse literal "family" for VISUAL classification (semantic-token
 * styling), as opposed to `classifyLiteral`'s type-matching -- e.g. a
 * `radix` literal and a `decimal` literal can both resolve to the same
 * base-types.yaml candidate set, but a user benefits from seeing at a
 * glance which notation they actually wrote. Kept independent of the
 * declared/expected type: this never fails or reports a mismatch, it just
 * names the shape. */
export type LiteralShapeKind = "bool" | "char" | "string" | "decimal" | "float" | "radix" | "time" | "date" | "pointer";

/** Returns the literal shape `raw`'s text looks like, or `null` if it
 * doesn't match any recognized .s7dcl literal syntax at all. */
export function detectLiteralShape(raw: string): LiteralShapeKind | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  if (/^(TRUE|FALSE)$/i.test(text)) return "bool";
  if (/^NULL$/i.test(text)) return "pointer"; // Any's zero-pointer literal
  if (/^ZERO$/i.test(text)) return "pointer"; // Pointer's zero-pointer literal

  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return "string";
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).length === 1 ? "char" : "string";
  }

  if (/^P#/i.test(text)) return "pointer";
  for (const [re] of DATE_TIME_PREFIXES) if (re.test(text)) return "date";
  if (DATE_BARE_RE.test(text)) return "date";
  for (const [re] of DURATION_PREFIXES) if (re.test(text)) return "time";

  if (parseRadixLiteral(text)) return "radix";

  // A fully typed constant (`BYTE#2#1111_0000`, `INT#-32768`, `BOOL#TRUE`,
  // `char#'B'`) styles as whatever its VALUE half is -- the type prefix
  // says what it's assignable to, not what notation the author wrote.
  const typedPrefix = TYPED_CONSTANT_PREFIX_RE.exec(text);
  if (typedPrefix) return detectLiteralShape(text.slice(typedPrefix[0].length));

  if (/^[+-]?\d[\d_]*$/.test(text)) return "decimal";
  if (/^[+-]?\d[\d_]*(\.\d+)?[eE][+-]?\d+$/.test(text) || /^[+-]?\d[\d_]*\.\d+$/.test(text)) return "float";

  return null;
}

/** Expands a pin's `dataTypes` list (instruction-registry) into concrete
 * base-types.yaml names, resolving category-index.yaml umbrella labels
 * (e.g. "Integers" -> SInt/Int/DInt/...) per instruction-registry/README.md's
 * "Pin data types" section. `skip` is true for the `"*"` marker ("all data
 * types legal" -- not a check to skip because it's unknown, but because
 * literally nothing is excluded), an empty list (nothing transcribed yet --
 * the README's "don't guess" rule), or the "PLC data type" umbrella (per
 * category-index.yaml's own notes, resolving a named UDT against a pin
 * needs a per-block symbol table richer than what's checked here -- don't
 * flag a UDT-accepting pin just because we can't enumerate its full
 * membership). */
export function expandPinDataTypes(dataTypes: string[], ruleSet: RuleSet): { skip: boolean; types: Set<string> } {
  if (dataTypes.length === 0 || dataTypes.includes("*") || dataTypes.includes("PLC data type")) {
    return { skip: true, types: new Set() };
  }
  const types = new Set<string>();
  for (const dt of dataTypes) {
    const umbrella = ruleSet.categoryIndex.umbrellaLabels[dt];
    if (umbrella) {
      for (const cat of umbrella.categories) {
        for (const t of ruleSet.categoryIndex.categoriesByType[cat]?.types ?? []) types.add(t);
      }
      continue;
    }
    types.add(dt);
  }
  return { skip: false, types };
}

/** base-types.yaml's `aliases` field (Time_Of_Day/TOD/TIME_OF_DAY,
 * LTime_Of_Day/LTOD, Date_And_Time/DT) means a VAR could be declared using
 * either spelling -- resolve to the canonical base-types.yaml key before
 * comparing an operand's declared type against a pin's `dataTypes` (which
 * always use the canonical spelling per instruction-registry/README.md's
 * "Pin data types" normalization rule). Returns `name` unchanged if it
 * isn't a known alias of anything. */
export function resolveTypeAlias(name: string, ruleSet: RuleSet): string {
  if (ruleSet.baseTypes[name]) return name;
  const upper = name.toUpperCase();
  for (const [canonical, entry] of Object.entries(ruleSet.baseTypes)) {
    const aliases = (entry as { aliases?: string[] }).aliases;
    if (aliases?.some((a) => a.toUpperCase() === upper)) return canonical;
  }
  return name;
}
