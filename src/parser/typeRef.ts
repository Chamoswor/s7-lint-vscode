// The TypeRef/MemberRef model from resources/type-registry/udt-dependency-cache.md's
// "Cache data model" section, shared by every UDT source-format parser
// (.udt / TYPE-block-in-.s7dcl, PLC data types/*.xml, and .s7dcl VAR
// sections) so the cache's build algorithm only has to walk one shape.
import { Token, TokenCursor } from "./lexer";

export type TypeRef =
  | { kind: "named"; name: string; quoted: boolean; namespace: string | null }
  | { kind: "array"; bounds: [number, number][]; of: TypeRef }
  | { kind: "inline-struct"; members: MemberRef[] }
  | { kind: "reference"; of: TypeRef };

export interface MemberRef {
  name: string;
  typeRef: TypeRef;
  /** 1-based source line, when the parser producing this MemberRef can
   * determine one (text formats can; the XML format currently cannot --
   * see udtXmlParser.ts). Diagnostics fall back to the declaration's own
   * line when this is absent. */
  line?: number;
}

export interface ArrayIssue {
  message: string;
}

/**
 * Parses a `Datatype`-style type text into a TypeRef.
 *
 * Handles, per resources/type-registry/udt-dependency-cache.md:
 *   - bare names: `Bool`, `ErrorStruct`, `IEC_TIMER`
 *   - quoted UDT references: `"UDT_Plain"` (.udt/TYPE-block convention)
 *   - XML-escaped quoted UDT references: `&quot;UDT_Plain&quot;` (decoded
 *     by the caller before this function ever sees the text)
 *   - namespace-dot-prefixed references: `_.UdtName` (.s7dcl VAR-section
 *     convention -- "_" is the working-theory default-namespace token,
 *     NOT independently confirmed, see udt-dependency-cache.md)
 *   - `Array[lo..hi[, lo..hi...]] of <Type>` (recursive; multi-dimension)
 *   - `Array[*] of <Type>` (dynamic-bounds ARRAY[*], composition-rules.yaml
 *     `array.dynamicBounds` -- bounds recorded as an empty list so callers
 *     can distinguish it from a fixed-bounds declaration)
 */
export function parseTypeRefText(raw: string): TypeRef {
  const text = raw.trim();

  const arrayMatch = /^Array\s*\[(.+?)\]\s*of\s+(.+)$/i.exec(text);
  if (arrayMatch) {
    const boundsText = arrayMatch[1].trim();
    const ofText = arrayMatch[2].trim();
    const bounds: [number, number][] = [];
    if (boundsText !== "*") {
      for (const dim of boundsText.split(",")) {
        const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(dim);
        if (m) bounds.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
      }
    }
    return { kind: "array", bounds, of: parseTypeRefText(ofText) };
  }

  const namespaceMatch = /^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/.exec(text);
  if (namespaceMatch && !text.startsWith('"')) {
    // `_.UdtName` or `MyNamespace.UdtName` (.s7dcl VAR-section convention).
    return {
      kind: "named",
      name: namespaceMatch[2].replace(/^"|"$/g, ""),
      quoted: false,
      namespace: namespaceMatch[1],
    };
  }

  const quotedMatch = /^"(.+)"$/.exec(text);
  if (quotedMatch) {
    return { kind: "named", name: quotedMatch[1], quoted: true, namespace: null };
  }

  return { kind: "named", name: text, quoted: false, namespace: null };
}

/** Renders a `TypeRef` back to display text for hover tooltips, e.g.
 * `Array[0..1] of Bool`, `_.FB_MotorProtection`, `STRUCT ... END_STRUCT`. */
export function typeRefToText(ref: TypeRef): string {
  if (ref.kind === "named") {
    const base = ref.namespace ? `${ref.namespace}.${ref.name}` : ref.name;
    return ref.quoted ? `"${base}"` : base;
  }
  if (ref.kind === "array") {
    const bounds = ref.bounds.length > 0 ? ref.bounds.map(([lo, hi]) => `${lo}..${hi}`).join(", ") : "*";
    return `Array[${bounds}] of ${typeRefToText(ref.of)}`;
  }
  if (ref.kind === "reference") return `REF_TO ${typeRefToText(ref.of)}`;
  return `STRUCT (${ref.members.length} member(s))`;
}

/** The ultimate named leaf of a `TypeRef` (drilling through `array`), used
 * to cross-reference a workspace block/UDT index by name. `null` for an
 * inline STRUCT, which has no single name to resolve. */
export function typeRefLeafName(ref: TypeRef): string | null {
  if (ref.kind === "named") return ref.name;
  if (ref.kind === "array" || ref.kind === "reference") return typeRefLeafName(ref.of);
  return null;
}

/** The type's OWN top-level kind, WITHOUT drilling through `array` the way
 * `typeRefLeafName` does -- `Array[0..1] of Int` is `"Array"` here, not
 * `"Int"`. Matches base-types.yaml's real `Array`/`Struct` keys (per
 * category-index.yaml's own notes, these are concrete type names, not
 * umbrella labels), so it's the right value to compare against an
 * instruction pin's `dataTypes` list -- a pin expecting a whole `Array`
 * operand is checking a different thing than one expecting a scalar
 * element (see instruction-registry/README.md's `containerKinds`). */
export function typeRefTopLevelName(ref: TypeRef): string | null {
  if (ref.kind === "named") return ref.name;
  if (ref.kind === "array") return "Array";
  if (ref.kind === "reference") return "Reference"; // matches base-types.yaml's real `Reference` key
  return "Struct";
}

/** The type a `REF_TO <X>`-declared tag resolves to once DEREFERENCED
 * (`#myRef^`) -- `null` if `ref` isn't a reference at all (nothing to
 * dereference) or if the referenced type has no single top-level name
 * (an inline STRUCT). Uses `typeRefTopLevelName` on the INNER type, not
 * `typeRefLeafName`, for the same Array-vs-element-type reason
 * `typeRefTopLevelName` itself exists. */
export function typeRefDereferencedTopLevelName(ref: TypeRef): string | null {
  return ref.kind === "reference" ? typeRefTopLevelName(ref.of) : null;
}

/** Recursively collects every `named` TypeRef reachable from `ref`. */
export function collectNamedRefs(ref: TypeRef, out: { name: string; quoted: boolean }[] = []): { name: string; quoted: boolean }[] {
  if (ref.kind === "named") {
    out.push({ name: ref.name, quoted: ref.quoted });
  } else if (ref.kind === "array" || ref.kind === "reference") {
    collectNamedRefs(ref.of, out);
  } else {
    for (const m of ref.members) collectNamedRefs(m.typeRef, out);
  }
  return out;
}

function parseBoundsFromTokens(tokens: Token[]): [number, number][] {
  const text = tokens.map((t) => t.text).join(" ");
  if (text.trim() === "*") return [];
  const bounds: [number, number][] = [];
  const re = /(-?\d+)\s*\.\s*\.\s*(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) bounds.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  return bounds;
}

/**
 * Recursive-descent counterpart to `parseTypeRefText`, for grammars where
 * a type appears as a token stream rather than one flat string -- the
 * `.udt`/TYPE-block STRUCT body and .s7dcl VAR-section member lists.
 * Handles `ARRAY[bounds] of <Type>` and `STRUCT ... END_STRUCT` (inline,
 * recursive) in addition to the named/quoted/namespaced cases
 * `parseTypeRefText` already covers.
 */
export function parseTypeRefFromCursor(cur: TokenCursor): TypeRef {
  if (cur.tryIdent("REF_TO")) {
    return { kind: "reference", of: parseTypeRefFromCursor(cur) };
  }

  if (cur.tryIdent("ARRAY")) {
    cur.tryPunct("[");
    const boundsTokens: Token[] = [];
    while (!cur.isPunct("]") && !cur.atEnd()) boundsTokens.push(cur.next());
    cur.tryPunct("]");
    cur.tryIdent("of");
    const of = parseTypeRefFromCursor(cur);
    return { kind: "array", bounds: parseBoundsFromTokens(boundsTokens), of };
  }

  if (cur.tryIdent("STRUCT")) {
    const members: MemberRef[] = [];
    while (!cur.isIdent("END_STRUCT") && !cur.atEnd()) {
      members.push(parseMemberFromCursor(cur));
    }
    cur.tryIdent("END_STRUCT");
    return { kind: "inline-struct", members };
  }

  if (cur.peek().kind === "string") {
    const t = cur.next();
    return { kind: "named", name: t.value ?? "", quoted: true, namespace: null };
  }

  const parts: string[] = [cur.next().text];
  while (cur.isPunct(".")) {
    cur.next();
    parts.push(cur.peek().kind === "string" ? (cur.next().value ?? "") : cur.next().text);
  }
  if (parts.length > 1) {
    return { kind: "named", name: parts[parts.length - 1], quoted: false, namespace: parts.slice(0, -1).join(".") };
  }
  return { kind: "named", name: parts[0], quoted: false, namespace: null };
}

/** `Name { pragma }? : TypeRef ;` -- shared member grammar for STRUCT
 * bodies (.udt/TYPE-block) and VAR sections (.s7dcl). The optional pragma
 * block is skipped, not modeled further (see udt-dependency-cache.md's
 * own "trigger rule UNCONFIRMED" note on these attribute blocks). */
export function parseMemberFromCursor(cur: TokenCursor): MemberRef {
  const nameTok = cur.next();
  cur.skipBraceBlock();
  cur.tryPunct(":");
  const typeRef = parseTypeRefFromCursor(cur);
  cur.tryPunct(";");
  return { name: nameTok.text, typeRef, line: nameTok.line };
}

/**
 * Array-bound sanity per composition-rules.yaml#array: lo <= hi per
 * dimension, and both fall within [-32768, 32767] regardless of declared
 * index type. `Array[*]` (empty bounds list) is exempt -- its bounds are
 * runtime-determined, not a static declaration to validate.
 */
export function checkArrayBounds(ref: TypeRef, limits: { min: number; max: number }): ArrayIssue[] {
  const issues: ArrayIssue[] = [];
  if (ref.kind === "array") {
    for (const [lo, hi] of ref.bounds) {
      if (lo > hi) {
        issues.push({ message: `Array bound lo (${lo}) > hi (${hi}) -- lo must be <= hi.` });
      }
      if (lo < limits.min || lo > limits.max || hi < limits.min || hi > limits.max) {
        issues.push({
          message: `Array bound [${lo}..${hi}] outside the legal index-value range [${limits.min}..${limits.max}] (applies regardless of the declared index type).`,
        });
      }
    }
    issues.push(...checkArrayBounds(ref.of, limits));
  } else if (ref.kind === "inline-struct") {
    for (const m of ref.members) issues.push(...checkArrayBounds(m.typeRef, limits));
  } else if (ref.kind === "reference") {
    issues.push(...checkArrayBounds(ref.of, limits));
  }
  return issues;
}
