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
  isArray: (name) => name === "Member" || name === "Section" || name === "SW.Types.PlcStruct",
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
