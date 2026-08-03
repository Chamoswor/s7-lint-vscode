// Workspace-wide index of program-block .s7dcl files (FUNCTION_BLOCK /
// FUNCTION / ORGANIZATION_BLOCK / DATA_BLOCK), keyed by block name. Unlike
// cache/typeCache.ts (which only indexes UDT-shaped sources), this covers
// the VAR_* sections of an actual block -- what a hover/definition provider
// needs to resolve `_.FB_MotorProtection`-style instance types and their pins
// (e.g. `#fbMvA.q_xBlockStart`) across files.
import { ParsedBlockFile, VarSection, parseS7dclFile } from "../parser/s7dclParser";
import { MemberRef } from "../parser/typeRef";
import { parseBlockXml } from "../parser/udtXmlParser";

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
  /** For a DATA_BLOCK: the type it is an instance of -- an instruction/system
   * type (unquoted) or a user FUNCTION_BLOCK/UDT (quoted). See
   * ParsedBlockFile.instanceOf. */
  instanceOf?: ParsedBlockFile["instanceOf"];
  /** A DATA_BLOCK header pragma's `InstructionName`, when present. */
  instructionName?: string;
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
    instanceOf: parsed.instanceOf,
    instructionName: parsed.instructionName,
  }));
}

/**
 * Turns one XML block export's declarations into `BlockInfo`s, so a DATA_BLOCK
 * TIA wrote as XML is indexed exactly like one written as text. Returns `[]`
 * for XML that declares no blocks (e.g. a UDT export), so callers can offer
 * every `.xml` file without pre-classifying it.
 *
 * `instanceOf.quoted` is set from `InstanceOfType`: TIA's text grammar quotes
 * a user FUNCTION_BLOCK's name and leaves an instruction/system type bare, and
 * `instanceTargetBlock`/`instanceDbInstructionMember` rely on that distinction
 * to decide whether to resolve members through the workspace or through the
 * instruction registry.
 */
export function scanBlockXmlFile(fsPath: string, text: string): BlockInfo[] {
  return parseBlockXml(text).map((parsed) => ({
    name: parsed.name,
    blockType: "DATA_BLOCK" as ParsedBlockFile["blockType"],
    file: fsPath,
    declLine: 1,
    vars: flattenVars(parsed.sections.map((s) => ({ kind: s.kind, members: s.members })) as VarSection[]),
    instanceOf: parsed.instanceOfName ? { name: parsed.instanceOfName, quoted: parsed.instanceOfType === "FB" } : undefined,
  }));
}

export class BlockIndex {
  /** Blocks scanned from files ON DISK (the workspace rebuild). */
  private diskBlocks = new Map<string, BlockInfo>();
  /** Blocks parsed from currently-OPEN editor buffers, keyed by file path --
   * see `setDocumentOverlay`. */
  private overlays = new Map<string, BlockInfo[]>();
  /** `diskBlocks` with every overlay applied on top; what lookups read. */
  private blocks = new Map<string, BlockInfo>();

  /**
   * `files` are the TEXT block sources (`.s7dcl`/`.scl`/`.db`); `xmlFiles`
   * are `*.xml` exports, which TIA uses for DATA_BLOCKs even when the
   * FUNCTION_BLOCK they instance is exported as text. Text wins on a name
   * clash: it is the format the rest of this parser chain models fully, and
   * a workspace holding both spellings of one block is a re-export artefact
   * rather than two different blocks.
   */
  rebuild(files: { path: string; text: string }[], xmlFiles: { path: string; text: string }[] = []): void {
    const next = new Map<string, BlockInfo>();
    for (const f of xmlFiles) {
      for (const info of scanBlockXmlFile(f.path, f.text)) next.set(info.name, info);
    }
    for (const f of files) {
      for (const info of scanBlockFile(f.path, f.text)) {
        next.set(info.name, info);
      }
    }
    this.diskBlocks = next;
    this.recompute();
  }

  /**
   * Register (or refresh) the blocks declared in an OPEN editor buffer.
   *
   * The workspace index is rebuilt from files on DISK, so a block declared in
   * the document being edited is invisible until that file is saved AND the
   * watcher-driven rebuild lands. That breaks TIA's "external source"
   * convention, where one `.scl` commonly declares an instance DB next to the
   * FUNCTION_BLOCK that calls it (`DATA_BLOCK "R_TRIG_DB" ... R_TRIG` +
   * `"R_TRIG_DB"();`) -- the buffer's own DB gets reported as
   * `external-symbol-not-found` while typing.
   *
   * Overlays live on the SHARED index rather than being applied per-caller, so
   * every consumer agrees: not just the lint pass, but hover, definition,
   * rename and completion too (a per-lint overlay left hover still saying
   * "not found in workspace" for a symbol the linter had just accepted).
   */
  setDocumentOverlay(path: string, text: string): void {
    this.overlays.set(path, scanBlockFile(path, text));
    this.recompute();
  }

  /** Drop a closed document's overlay, falling back to its on-disk version. */
  clearDocumentOverlay(path: string): void {
    if (this.overlays.delete(path)) this.recompute();
  }

  /** Disk blocks first, then open buffers on top (a buffer's own, possibly
   * unsaved, definition wins over the stale on-disk one). */
  private recompute(): void {
    const merged = new Map(this.diskBlocks);
    for (const infos of this.overlays.values()) {
      for (const info of infos) merged.set(info.name, info);
    }
    this.blocks = merged;
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
