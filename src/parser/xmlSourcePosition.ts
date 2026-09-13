// Source lines for elements parsed by fast-xml-parser. With the parser's
// `captureMetaData` option every element node records the offset where its
// start tag begins; this turns that offset into the 1-based line diagnostics
// and definition locations use, so an XML export's declarations and members
// point at their own lines instead of all at line 1.
import { XMLParser } from "fast-xml-parser";

const METADATA = XMLParser.getMetaDataSymbol() as unknown as symbol;

/** Drops a leading byte-order mark, so the offsets the parser reports and
 * the line table are computed over exactly the same text. */
export function withoutByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class XmlLineIndex {
  private readonly lineStarts: number[] = [0];

  constructor(private readonly text: string) {
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) this.lineStarts.push(at + 1);
  }

  /** 1-based line of the character at `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Line of `node`'s start tag, or undefined for a value without a recorded
   * position (a text-only element parses to a plain string). */
  lineOf(node: unknown): number | undefined {
    const start = startOffset(node);
    return start === undefined ? undefined : this.lineAt(start);
  }

  /** Line of the first `<childTag>` inside `node`, an element closed by
   * `</elementTag>`. For a text-only child such as `<Name>`, whose value is a
   * plain string with no position of its own. Falls back to `node`'s line. */
  textChildLine(node: unknown, elementTag: string, childTag: string): number | undefined {
    const start = startOffset(node);
    if (start === undefined) return undefined;
    const end = this.text.indexOf(`</${elementTag}>`, start);
    const child = this.text.indexOf(`<${childTag}>`, start);
    return this.lineAt(child !== -1 && (end === -1 || child < end) ? child : start);
  }
}

function startOffset(node: unknown): number | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const metadata = (node as Record<symbol, { startIndex?: number } | undefined>)[METADATA];
  return typeof metadata?.startIndex === "number" ? metadata.startIndex : undefined;
}
