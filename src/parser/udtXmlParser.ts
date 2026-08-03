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

export interface ParsedUdtDecl {
  name: string;
  members: MemberRef[];
  line: number; // XML has no useful line info per-declaration; always 1
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    name === "Member" ||
    name === "Section" ||
    name === "SW.Types.PlcStruct" ||
    name === "SW.Blocks.InstanceDB" ||
    name === "SW.Blocks.GlobalDB",
});

function memberDatatypeToTypeRef(datatype: string): TypeRef {
  return parseTypeRefText(datatype);
}

/** Parses one `PLC data types/*.xml` file's text into its top-level UDT declaration(s). */
export function parseUdtXml(text: string): ParsedUdtDecl[] {
  let doc: any;
  try {
    doc = parser.parse(text);
  } catch {
    return [];
  }

  const structs = doc?.Document?.["SW.Types.PlcStruct"];
  if (!structs) return [];
  const list = Array.isArray(structs) ? structs : [structs];

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
      }));

    results.push({ name, members, line: 1 });
  }
  return results;
}

/** One DATA_BLOCK declared by an XML export, in the shape the workspace
 * block index needs (see `parseBlockXml`). */
export interface ParsedXmlBlock {
  name: string;
  /** `SW.Blocks.InstanceDB`'s `InstanceOfName` -- the FUNCTION_BLOCK or
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
 * TIA exports an instance DB as XML (`SW.Blocks.InstanceDB`) while the
 * FUNCTION_BLOCK it instances is exported as text, so a workspace can
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
  let doc: any;
  try {
    doc = parser.parse(text);
  } catch {
    return [];
  }
  const root = doc?.Document;
  if (!root) return [];

  const results: ParsedXmlBlock[] = [];
  for (const key of ["SW.Blocks.InstanceDB", "SW.Blocks.GlobalDB"]) {
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
          .map((m) => ({ name: m["@_Name"] as string, typeRef: memberDatatypeToTypeRef(m["@_Datatype"] as string) }));
        if (members.length > 0) sections.push({ kind: XML_SECTION_TO_VAR[secName] ?? "VAR", members });
      }

      const instanceOfName = typeof attrs?.InstanceOfName === "string" ? attrs.InstanceOfName : undefined;
      const instanceOfType = typeof attrs?.InstanceOfType === "string" ? attrs.InstanceOfType : undefined;
      results.push({ name, instanceOfName, instanceOfType, sections });
    }
  }
  return results;
}
