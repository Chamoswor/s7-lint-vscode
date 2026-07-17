// Workspace-wide index of program-block .s7dcl files (FUNCTION_BLOCK /
// FUNCTION / ORGANIZATION_BLOCK / DATA_BLOCK), keyed by block name. Unlike
// cache/typeCache.ts (which only indexes UDT-shaped sources), this covers
// the VAR_* sections of an actual block -- what a hover/definition provider
// needs to resolve `_.FB_MotorProtection`-style instance types and their pins
// (e.g. `#fbMvA.q_xBlockStart`) across files.
import { ParsedBlockFile, VarSection, parseS7dclFile } from "../parser/s7dclParser";
import { MemberRef } from "../parser/typeRef";

export interface BlockVar {
  name: string;
  member: MemberRef;
  section: string; // VAR_INPUT | VAR_OUTPUT | VAR_IN_OUT | VAR_TEMP | VAR_CONSTANT | VAR
}

export interface BlockInfo {
  name: string;
  blockType: ParsedBlockFile["blockType"];
  file: string;
  declLine: number;
  vars: Map<string, BlockVar>;
}

function flattenVars(sections: VarSection[]): Map<string, BlockVar> {
  const vars = new Map<string, BlockVar>();
  for (const section of sections) {
    for (const member of section.members) {
      // First declaration wins on a name clash -- shouldn't happen in a
      // valid export, but stay deterministic rather than throwing.
      if (!vars.has(member.name)) {
        vars.set(member.name, { name: member.name, member, section: section.kind });
      }
    }
  }
  return vars;
}

/** Parses one file's text into every program-block declaration it contains
 * (usually one, for a `.s7dcl` export -- but an authored `.scl` source file
 * may bundle several FUNCTION_BLOCK/FUNCTION/... declarations, see
 * `parseS7dclFile`). Empty for a file with no program-block declarations at
 * all (e.g. a pure TYPE/UDT file). */
export function scanBlockFile(fsPath: string, text: string): BlockInfo[] {
  // The block-name token's line isn't retained on ParsedBlockFile today;
  // line 1 is a safe, simple fallback -- every real export's block keyword
  // is at or near the top of the file anyway (and a multi-declaration .scl
  // file's later declarations don't have a meaningfully "more correct" line
  // to fall back to either without deeper parser changes).
  return parseS7dclFile(text).map((parsed) => ({
    name: parsed.name,
    blockType: parsed.blockType,
    file: fsPath,
    declLine: 1,
    vars: flattenVars(parsed.varSections),
  }));
}

export class BlockIndex {
  private blocks = new Map<string, BlockInfo>();

  rebuild(files: { path: string; text: string }[]): void {
    const next = new Map<string, BlockInfo>();
    for (const f of files) {
      for (const info of scanBlockFile(f.path, f.text)) {
        next.set(info.name, info);
      }
    }
    this.blocks = next;
  }

  get(name: string): BlockInfo | undefined {
    const exact = this.blocks.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const info of this.blocks.values()) {
      if (info.name.toLowerCase() === lower) return info;
    }
    return undefined;
  }

  get size(): number {
    return this.blocks.size;
  }

  /** Every indexed block across the whole workspace -- used by
   * providers/completion.ts to offer every quotable external-reference
   * name (`"Name"(...)`/`"Name".member`) once the user has typed an
   * opening `"`. */
  values(): BlockInfo[] {
    return [...this.blocks.values()];
  }
}
