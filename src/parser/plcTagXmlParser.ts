// Parses TIA Portal PLC tag-table XML exports (`SW.Tags.PlcTagTable`).
// These files are neither PLC data types nor DATA_BLOCK exports, so the two
// existing XML parsers intentionally return nothing for them. Keeping this
// parser separate preserves that format boundary while letting the shared
// workspace index resolve a quoted symbolic operand such as `"DI_Reset"` to
// its declared Bool/Int/... type instead of treating it as a string literal.
import { XMLParser } from "fast-xml-parser";
import { TypeRef, parseTypeRefText } from "./typeRef";

export interface ParsedPlcTag {
  name: string;
  dataTypeName: string;
  typeRef: TypeRef;
  logicalAddress?: string;
  comments: Map<string, string>;
  line: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "SW.Tags.PlcTagTable" || name === "SW.Tags.PlcTag" || name === "MultilingualTextItem",
});

/** Returns every tag declared by a TIA PLC tag-table XML export. */
export function parsePlcTagXml(text: string): ParsedPlcTag[] {
  let doc: any;
  try {
    doc = parser.parse(text);
  } catch {
    return [];
  }

  const root = doc?.Document;
  if (!root) return [];
  const tables: any[] = root["SW.Tags.PlcTagTable"] ?? [];
  const results: ParsedPlcTag[] = [];

  for (const table of tables) {
    const rawTags = table?.ObjectList?.["SW.Tags.PlcTag"];
    const tags: any[] = Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [];
    for (const tag of tags) {
      const attrs = tag?.AttributeList;
      const name = attrs?.Name;
      const dataTypeName = attrs?.DataTypeName;
      if (typeof name !== "string" || !name || typeof dataTypeName !== "string" || !dataTypeName) continue;

      const comments = new Map<string, string>();
      const rawItems = tag?.ObjectList?.MultilingualText?.ObjectList?.MultilingualTextItem;
      const items: any[] = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
      for (const item of items) {
        const culture = item?.AttributeList?.Culture;
        const comment = item?.AttributeList?.Text;
        if (typeof culture === "string" && typeof comment === "string") comments.set(culture, comment);
      }

      const logicalAddress = typeof attrs?.LogicalAddress === "string" ? attrs.LogicalAddress : undefined;
      results.push({
        name,
        dataTypeName,
        typeRef: parseTypeRefText(dataTypeName),
        logicalAddress,
        comments,
        line: 1,
      });
    }
  }

  return results;
}
