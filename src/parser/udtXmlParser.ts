// Parses `PLC data types/**/*.xml` exports (root `SW.Types.PlcStruct`,
// per copilot-instructions.md and udt-dependency-cache.md's "XML export
// is a FOURTH, architecturally different case" section). This is the
// PRIMARY UDT source format for this project (per user direction,
// 2026-07-13) -- .udt/TYPE-block text is a secondary/best-effort path.
//
// The XML export is SELF-RESOLVING: TIA recursively inlines the full
// expanded shape of every UDT/system-struct reference at the point of
// use. We deliberately do NOT walk into a member's own nested <Sections>
// -- that inner content is TIA's own already-resolved copy of a type
// this cache tracks independently under its own name, not this member's
// own declaration. Truncating there keeps the same MemberRef/TypeRef
// shape (and the same cache graph algorithm) as the .udt text format.
import { XMLParser } from "fast-xml-parser";
import { MemberRef, TypeRef, parseTypeRefText } from "./typeRef";
import { XmlLineIndex, normalizeXmlSource } from "./xmlSourcePosition";

export interface ParsedUdtDecl {
  name: string;
  members: MemberRef[];
  /** Line of the declaration's own `<Name>` element. */
  line: number;
}

const XML_BLOCK_ELEMENTS = [
  "SW.Blocks.InstanceDB",
  "SW.Blocks.GlobalDB",
  "SW.TechnologicalObjects.TechnologicalInstanceDB",
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Each element records where it starts, so declarations and members keep
  // their own source line -- see xmlSourcePosition.ts.
  captureMetaData: true,
  isArray: (name) =>
    name === "Member" ||
    name === "Section" ||
    name === "SW.Types.PlcStruct" ||
    XML_BLOCK_ELEMENTS.includes(name),
});

function memberDatatypeToTypeRef(datatype: string): TypeRef {
  return parseTypeRefText(datatype);
}

/** Parses one `PLC data types/*.xml` file's text into its top-level UDT declaration(s). */
export function parseUdtXml(text: string): ParsedUdtDecl[] {
  // Every XML export is offered to every XML parser, so skip the parse
  // outright when this one's root element can't be in the file.
  if (!text.includes("<SW.Types.PlcStruct")) return [];
  const source = normalizeXmlSource(text);
  let doc: any;
  try {
    doc = parser.parse(source);
  } catch {
    return [];
  }

  const structs = doc?.Document?.["SW.Types.PlcStruct"];
  if (!structs) return [];
  const list = Array.isArray(structs) ? structs : [structs];
  const lines = new XmlLineIndex(source);

  const results: ParsedUdtDecl[] = [];
  for (const s of list) {
    const attrs = s?.AttributeList;
    const name: string | undefined = attrs?.Name;
    if (!name) continue;

    const sections = attrs?.Interface?.Sections?.Section;
    const sectionList = Array.isArray(sections) ? sections : sections ? [sections] : [];
    const noneSection = sectionList.find((sec: any) => sec?.["@_Name"] === "None") ?? sectionList[0];
    const memberList: any[] = noneSection?.Member
      ? Array.isArray(noneSection.Member)
        ? noneSection.Member
        : [noneSection.Member]
      : [];

    const members: MemberRef[] = memberList
      .filter((m) => typeof m?.["@_Name"] === "string" && typeof m?.["@_Datatype"] === "string")
      .map((m) => ({
        name: m["@_Name"] as string,
        typeRef: memberDatatypeToTypeRef(m["@_Datatype"] as string),
        line: lines.lineOf(m),
      }));

    results.push({ name, members, line: lines.textChildLine(s, "SW.Types.PlcStruct", "Name") ?? 1 });
  }
  return results;
}

/** One DATA_BLOCK declared by an XML export, in the shape the workspace
 * block index needs (see `parseBlockXml`). */
export interface ParsedXmlBlock {
  name: string;
  /** Line of the block's own `<Name>` element. */
  line: number;
  /** An instance DB's `InstanceOfName` -- the FUNCTION_BLOCK or
   * instruction this DB is the instance data for. Undefined for a global DB. */
  instanceOfName?: string;
  /** `InstanceOfType`, e.g. `FB`. Undefined for a global DB. */
  instanceOfType?: string;
  /** Interface members grouped by their `<Section Name="...">`, using the
   * same `VAR_*` section spelling the text formats produce so both sources
   * flatten identically downstream. */
  sections: { kind: string; members: MemberRef[] }[];
}

/** `<Section Name="...">` -> the `VAR_*` keyword the text exports use for the
 * same section, so an XML-sourced block's members are indistinguishable from
 * a `.s7dcl`-sourced one to every consumer. `Static` maps to plain `VAR`,
 * matching `parseS7dclFile`'s own handling of a FUNCTION_BLOCK's static area. */
const XML_SECTION_TO_VAR: Record<string, string> = {
  Input: "VAR_INPUT",
  Output: "VAR_OUTPUT",
  InOut: "VAR_IN_OUT",
  Static: "VAR",
  Temp: "VAR_TEMP",
  Constant: "VAR_CONSTANT",
  None: "VAR",
};

/**
 * Parses a `*.xml` block export into the DATA_BLOCKs it declares.
 *
 * TIA exports ordinary instance DBs (`SW.Blocks.InstanceDB`) and technology
 * object instance DBs (`SW.TechnologicalObjects.TechnologicalInstanceDB`)
 * using the same XML interface/instance metadata. A user FUNCTION_BLOCK
 * can still be exported as text, so a workspace can
 * legitimately hold blocks in both formats. Indexing only the text ones made
 * every reference to an XML-exported DB -- `"Some_DB".member` operands, and
 * `"Some_DB"(...)` calls -- look like a reference to a block that does not
 * exist anywhere.
 *
 * Returns `[]` for any XML that isn't a block export (a UDT export, or
 * anything else), so the same file can be offered to this and to
 * `parseUdtXml` without either having to pre-classify it.
 */
export function parseBlockXml(text: string): ParsedXmlBlock[] {
  if (!XML_BLOCK_ELEMENTS.some((key) => text.includes(`<${key}`))) return [];
  const source = normalizeXmlSource(text);
  let doc: any;
  try {
    doc = parser.parse(source);
  } catch {
    return [];
  }
  const root = doc?.Document;
  if (!root) return [];
  const lines = new XmlLineIndex(source);

  const results: ParsedXmlBlock[] = [];
  for (const key of XML_BLOCK_ELEMENTS) {
    for (const block of (root[key] ?? []) as any[]) {
      const attrs = block?.AttributeList;
      const name: unknown = attrs?.Name;
      if (typeof name !== "string" || !name) continue;

      const rawSections = attrs?.Interface?.Sections?.Section;
      const sectionList = Array.isArray(rawSections) ? rawSections : rawSections ? [rawSections] : [];
      const sections: { kind: string; members: MemberRef[] }[] = [];
      for (const sec of sectionList) {
        const secName: string = sec?.["@_Name"] ?? "None";
        const memberList: any[] = Array.isArray(sec?.Member) ? sec.Member : sec?.Member ? [sec.Member] : [];
        const members: MemberRef[] = memberList
          .filter((m) => typeof m?.["@_Name"] === "string" && typeof m?.["@_Datatype"] === "string")
          .map((m) => ({ name: m["@_Name"] as string, typeRef: memberDatatypeToTypeRef(m["@_Datatype"] as string), line: lines.lineOf(m) }));
        if (members.length > 0) sections.push({ kind: XML_SECTION_TO_VAR[secName] ?? "VAR", members });
      }

      const instanceOfName = typeof attrs?.InstanceOfName === "string" ? attrs.InstanceOfName : undefined;
      const instanceOfType = typeof attrs?.InstanceOfType === "string" ? attrs.InstanceOfType : undefined;
      results.push({ name, line: lines.textChildLine(block, key, "Name") ?? 1, instanceOfName, instanceOfType, sections });
    }
  }
  return results;
}
