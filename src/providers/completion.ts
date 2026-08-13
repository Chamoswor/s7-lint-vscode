// Completion on "#", ".", '"', and a bare identifier. "#" (bare, or with
// some identifier characters already typed) lists every locally-declared
// tag (VAR_INPUT/OUTPUT/IN_OUT/TEMP/VAR/VAR_CONSTANT) -- the same set
// `#`-prefixed operand references in this grammar draw from.
//
// "." after a resolved tag lists its members. The base may be spelled either
// `#tag.` or -- inside an `.scl` body -- bare `tag.`, since TIA's own
// external-source importer resolves both against the block's declarations
// (see parser/s7dclParser.ts's `LocalTagNames`); both produce the identical
// list. Members come from whichever of four stores actually describes the
// resolved type, and one chain hops between them freely -- see `MemberSource`:
// a workspace FUNCTION_BLOCK/DATA_BLOCK's own VAR members, a UDT's fields
// (type cache), a system-struct's fields (system-types.yaml -- IEC_TIMER,
// ErrorStruct, ...), an inline `STRUCT ... END_STRUCT`'s fields, or a
// timer/counter/edge instruction instance's registry pins.
//
// '"' (bare, or with some identifier characters already typed) lists every
// WORKSPACE BLOCK name instead -- the "global plane" a double-quoted
// external reference draws from (see analysis/symbolTable.ts's
// `resolveOperandRef` `isExternal` handling / `linter/sclInstructionChecks.
// ts`'s `resolveCallEntry` `externalName` handling, both added alongside
// this). A bare identifier (no leading `#`/`.`/`"`) lists the three planes
// that position accepts -- local tags, callable workspace blocks, and the
// catalog INSTRUCTION names -- each row labelled with which one it came
// from, since they look identical once typed (see
// `bareIdentifierCompletions`). All of these reuse the exact same resolution
// the hover/definition providers already do (see analysis/documentIndex.ts's
// `localDecls`/`listInstanceMembers`/`renderInstructionHover`, and
// analysis/blockIndex.ts's own `values()`) via a text-based backward scan
// for the operand chain immediately before the cursor, rather than
// re-running the full token-cursor walk (which isn't meant to cope with
// the mid-edit, possibly-incomplete text after the cursor).
import * as vscode from "vscode";
import { BlockIndex, BlockInfo } from "../analysis/blockIndex";
import {
  blockScopeAt,
  buildDocumentIndex,
  isDotAccessLegal,
  listInstanceMembers,
  LocalDecl,
  renderInstructionHover,
  resolveInstanceTypeToInstructionNames,
} from "../analysis/documentIndex";
import { DeclSubContext, legalTypeNamesForSection, resolveSclCompletionContext, SclSection } from "../analysis/sclCompletionContext";
import { lookupType, TypeCacheResult } from "../cache/typeCache";
import { Lexer } from "../parser/lexer";
import { MemberRef, TypeRef, typeRefLeafName, typeRefToText, typeRefTopLevelName } from "../parser/typeRef";
import { InstructionEntry, RuleSet, SystemTypeEntry, SystemTypeMember, SystemTypeMemberTypeRef } from "../rules/types";
import {
  buildInstanceDeclarationEdit,
  buildSingleInstanceDbEdit,
  fbInstanceRef,
  instructionInstanceRef,
  resolveBlockInstanceContext,
} from "./instanceQuickFix";

const CHAIN_BEFORE_DOT_RE = /(#[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/;
/** The same member-chain trigger for the BARE, `#`-less spelling of a local
 * reference -- `SeqEdge.` must offer exactly what `#SeqEdge.` offers, since
 * TIA's own importer resolves both against the block's declarations (see
 * parser/s7dclParser.ts's `LocalTagNames`). The lookbehind keeps it off the
 * two chain shapes that have their own trigger: a `#tag` chain
 * (`CHAIN_BEFORE_DOT_RE`, tried first anyway) and a quoted external base
 * (`QUOTED_CHAIN_BEFORE_DOT_RE`, whose own branch returns before this one is
 * reached). The base still has to resolve to a real local declaration, so a
 * bare word that isn't one simply yields no completions. */
const BARE_CHAIN_BEFORE_DOT_RE = /(?<![#"A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/;
/** The same member-chain trigger, but rooted at a QUOTED external block
 * reference (`"R_TRIG_DB".` / `"Pump_DB".member.`) instead of a `#tag`.
 * Siemens' own convention for referencing a workspace block -- including a
 * global instance DB, which is the only way to reach an `instance-dot`
 * instruction's members from outside a FUNCTION_BLOCK. Capture 1 is the
 * quoted name, capture 2 the already-typed `.member` chain (possibly empty). */
const QUOTED_CHAIN_BEFORE_DOT_RE = /"([A-Za-z_][A-Za-z0-9_]*)"((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/;
const HASH_TAG_RE = /#[A-Za-z0-9_]*$/;
// A bare double-quote, or one with some identifier characters already
// typed after it -- e.g. `"` or `"Test_D` -- the start of an external
// workspace-block reference (`"Name"(...)`/`"Name".member`). Deliberately
// simple (no closing-quote awareness), matching HASH_TAG_RE's own
// tolerance for mid-edit, possibly-incomplete text.
const QUOTED_REF_RE = /"[A-Za-z0-9_]*$/;
// A bare identifier NOT immediately preceded by `#` (a tag reference,
// already handled by HASH_TAG_RE above), `"` (an external reference,
// handled by QUOTED_REF_RE above), or `.` (a member-access segment,
// mid-typing after CHAIN_BEFORE_DOT_RE's own trigger dot -- an instruction
// name is never a struct/instance member name).
const BARE_IDENT_RE = /(?<![A-Za-z0-9_#."])[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Where the members offered after a `.` come from. Four backing stores hold
 * "a thing with named fields" in four different shapes, and one dot chain can
 * hop between them freely (`#fbPump.settings.limits.` -- workspace block,
 * then UDT, then inline STRUCT), so each is adapted to this single union
 * rather than re-handled at every step:
 *   - `block`    -- a workspace FB/FC/OB/DB's own VAR members (BlockIndex).
 *                   Kept distinct because its members carry a VAR_* section
 *                   and can hop THROUGH an instance DB to what it instances.
 *   - `fields`   -- anything whose members are a plain declared list: a UDT
 *                   from the type cache, a system-struct from
 *                   system-types.yaml (IEC_TIMER, ErrorStruct, TCON_Param,
 *                   ...), or an inline `STRUCT ... END_STRUCT` declared in
 *                   this very document.
 *   - `instance` -- a timer/counter/edge instruction instance, whose
 *                   "members" are its registry pins (`listInstanceMembers`).
 */
type MemberSource =
  | { kind: "block"; block: BlockInfo }
  | { kind: "fields"; label: string; entries: MemberEntry[] }
  | { kind: "instance"; typeName: string };

/** One named field, normalized out of whichever store it came from. */
interface MemberEntry {
  name: string;
  typeText: string;
  /** Ultimate named leaf of the field's type (drilled through Array/REF_TO). */
  leafName: string | null;
  /** The field's OWN top-level type name (`Array` for an array, etc.). */
  topLevelName: string | null;
  /** Set when the field's own type is an inline STRUCT -- which has no name
   * to look anything up by, so its fields travel with it. */
  nested?: MemberEntry[];
}

function entryFromMemberRef(m: MemberRef): MemberEntry {
  return {
    name: m.name,
    typeText: typeRefToText(m.typeRef),
    leafName: typeRefLeafName(m.typeRef),
    topLevelName: typeRefTopLevelName(m.typeRef),
    nested: inlineStructEntriesOf(m.typeRef),
  };
}

function entryFromLocalDecl(d: LocalDecl): MemberEntry {
  return {
    name: d.name,
    typeText: d.typeText,
    leafName: d.elementLeafName ?? d.leafName,
    topLevelName: d.topLevelName,
    nested: d.structMembers?.map(entryFromLocalDecl),
  };
}

/** system-types.yaml stores member types in its own YAML-native shape
 * (`SystemTypeMemberTypeRef`), not the parser's `TypeRef` -- drilled the
 * same way here so a system-struct field chains onward like any other. */
function entryFromSystemTypeMember(m: SystemTypeMember): MemberEntry {
  const drill = (ref: SystemTypeMemberTypeRef): SystemTypeMemberTypeRef => (ref.kind === "array" && ref.of ? drill(ref.of) : ref);
  const leaf = drill(m.type);
  return {
    name: m.name,
    typeText: m.type.kind === "array" ? `Array of ${leaf.name ?? leaf.kind}` : leaf.name ?? leaf.kind,
    leafName: leaf.name ?? null,
    topLevelName: m.type.kind === "named" ? m.type.name ?? null : m.type.kind === "array" ? "Array" : "Struct",
    nested: leaf.kind === "inline-struct" ? (leaf.members ?? []).map((sub) => entryFromSystemTypeMember({ name: sub.name, type: sub.typeRef })) : undefined,
  };
}

/** An inline `STRUCT` type's own fields, drilled through Array/REF_TO --
 * `undefined` for every other TypeRef. */
function inlineStructEntriesOf(ref: TypeRef): MemberEntry[] | undefined {
  if (ref.kind === "array" || ref.kind === "reference") return inlineStructEntriesOf(ref.of);
  return ref.kind === "inline-struct" ? ref.members.map(entryFromMemberRef) : undefined;
}

/** system-types.yaml lookup by name, ignoring case (SCL type names are
 * case-insensitive) -- returns the CANONICAL key alongside the entry so the
 * completion detail shows the registry's own spelling. */
function findSystemType(ruleSet: RuleSet, name: string): { name: string; entry: SystemTypeEntry } | undefined {
  const exact = ruleSet.systemTypes[name];
  if (exact) return { name, entry: exact };
  const lower = name.toLowerCase();
  for (const [key, entry] of Object.entries(ruleSet.systemTypes)) {
    if (key.toLowerCase() === lower) return { name: key, entry };
  }
  return undefined;
}

export class S7dclCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly ruleSet: RuleSet, private readonly blockIndex: BlockIndex, private readonly getTypeCache: () => TypeCacheResult) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Section-aware gating is SCL-specific (VAR_*/BEGIN is this grammar's
    // own structure) -- a `.s7dcl`/`.s7udt` document keeps its existing,
    // unrestricted behavior untouched (out of scope here; those files
    // aren't hand-typed member-by-member the same way, and don't have this
    // request's VAR-section/type-position editing workflow at all).
    if (document.languageId === "s7scl") {
      const ctx = resolveSclCompletionContext(text, offset);
      if (ctx.kind === "none") return [];
      if (ctx.kind === "root") return this.topLevelCompletions(document, offset);
      if (ctx.kind === "declaration") return this.declarationCompletions(document, offset, ctx.section, ctx.decl);
      if (ctx.kind === "function-return-type") return this.functionReturnTypeCompletions(document, text, offset, ctx.anchorEnd, ctx.identStart);
      if (ctx.kind === "data-block-instance-ref") return this.dataBlockInstanceRefCompletions(document, offset, ctx.identStart, ctx.textSoFar);
      // ctx.kind === "executable" -- falls through to the same tag/
      // instruction/external-reference completions below.
    }

    return this.executableCompletions(document, position, text, offset);
  }

  /** Tag (`#`), instance-member (`.`), external-block (`"`), and
   * instruction (bare identifier) completions -- the ENTIRE previous
   * behavior of this provider, unchanged, now scoped to firing only
   * inside an executable body (BEGIN ... END_xxx) for an `.scl` document
   * (still unconditional for `.s7dcl`/`.s7udt`, see `provideCompletionItems`). */
  private executableCompletions(document: vscode.TextDocument, position: vscode.Position, text: string, offset: number): vscode.CompletionItem[] | undefined {
    const before = text.slice(0, offset);

    // A quoted external base (`"R_TRIG_DB".`) resolves its members from the
    // referenced BLOCK rather than a local declaration -- and when that block
    // is an instance DB, from whatever it instances (see `instanceMemberRoot`).
    const quotedMatch = QUOTED_CHAIN_BEFORE_DOT_RE.exec(before);
    if (quotedMatch) {
      const baseBlock = this.blockIndex.get(quotedMatch[1]);
      const root = this.instanceMemberRoot(baseBlock);
      if (!root) return undefined;
      const rest = quotedMatch[2] ? quotedMatch[2].split(".").filter(Boolean) : [];
      const items = this.memberCompletions(root.ownerBlock, root.topLevelName, rest, root.preferScl);
      // Dotting into a BARE FUNCTION_BLOCK type is illegal (TIA refuses it --
      // see the `dot-access-needs-instance` diagnostic). Still offer its
      // members, but make accepting one ALSO create a single-instance DB and
      // repoint the reference at it, so one keystroke yields legal code --
      // the same auto-import mechanism the instruction completion uses.
      if (items && baseBlock?.blockType === "FUNCTION_BLOCK") {
        return this.withInstanceAutoCreate(document, position, items, baseBlock, quotedMatch.index);
      }
      return items;
    }

    // The `#`-prefixed chain, then the bare one -- the SAME completion for
    // the SAME reference, since TIA's importer accepts both spellings (see
    // parser/s7dclParser.ts's `LocalTagNames`). The bare form is restricted
    // to `.scl`, matching where the linter and document index accept it: a
    // `.s7dcl` RUNG is full of bare identifiers that are not tag references.
    const match = CHAIN_BEFORE_DOT_RE.exec(before) ?? (document.languageId === "s7scl" ? BARE_CHAIN_BEFORE_DOT_RE.exec(before) : null);
    if (!match) {
      if (HASH_TAG_RE.test(before)) {
        return this.declsInScope(text, position).map((decl) => this.localTagItem(decl));
      }
      if (QUOTED_REF_RE.test(before)) return this.externalBlockCompletions();
      if (BARE_IDENT_RE.test(before)) return this.bareIdentifierCompletions(document, position, text);
      return undefined;
    }

    const segments = match[1].split(".");
    const baseTag = segments[0].startsWith("#") ? segments[0].slice(1) : segments[0];
    const chainRest = segments.slice(1);

    const decl = this.declsInScope(text, position).find((d) => d.name.toLowerCase() === baseTag.toLowerCase());
    if (!decl) return undefined;

    // An `.scl` body spells instruction pins the way its own registry half
    // does (`Q`/`CLK`, not the graphical `q`/`clk`) -- see listInstanceMembers.
    const preferScl = document.languageId === "s7scl";
    return this.memberCompletions(
      this.blockIndex.get(decl.leafName ?? ""),
      decl.topLevelName,
      chainRest,
      preferScl,
      decl.elementLeafName ?? decl.leafName,
      decl.structMembers?.map(entryFromLocalDecl)
    );
  }

  /** The tags actually addressable at `position` -- the VAR sections of the
   * ONE block declaration containing it, in declaration order.
   *
   * An authored `.scl` routinely bundles several declarations in one file,
   * and SCL scopes tags hard between them: `#CmdProc`/`CmdProc` is a real
   * reference inside the FB that declares it and an undeclared identifier
   * three declarations later. Offering the whole file's tags therefore
   * completed code TIA rejects, and (since two blocks can declare the same
   * name) could resolve a member list against the wrong declaration
   * entirely.
   *
   * Falls back to every declaration seen when the document has NO block
   * declarations at all -- a `.udt`/TYPE-only file, where there's no block
   * structure to scope by and the previous flat behavior is all there is. */
  private declsInScope(text: string, position: vscode.Position): LocalDecl[] {
    const index = buildDocumentIndex(text, this.ruleSet, this.blockIndex);
    if (index.blockScopes.length === 0) return [...index.localDecls.values()];
    const scope = blockScopeAt(index, position.line + 1);
    return scope ? [...scope.decls.values()] : [];
  }

  /** True when `decl` names a CALLABLE, state-owning instance -- a
   * FUNCTION_BLOCK instance or a timer/counter/edge instruction instance
   * (TON, R_TRIG, CTU, ...) -- rather than a plain data variable. Mirrors
   * analysis/documentIndex.ts's `localTagTokenType` (which decides the same
   * thing for semantic-token coloring); the two answer the same question
   * for the two different surfaces the user sees it on. */
  private isInstanceDecl(decl: LocalDecl): boolean {
    const leaf = decl.elementLeafName ?? decl.leafName;
    if (leaf && this.blockIndex.get(leaf)?.blockType === "FUNCTION_BLOCK") return true;
    const top = decl.elementTopLevelName ?? decl.topLevelName;
    return !!top && resolveInstanceTypeToInstructionNames(this.ruleSet, top).length > 0;
  }

  /** One completion row for a locally-declared tag. `sortGroup`/`prefix`
   * are set by the BARE-identifier list (where local tags share the list
   * with the instruction catalog and workspace blocks); the `#`-triggered
   * list leaves both at their defaults, since everything in it is a local
   * tag already. */
  private localTagItem(decl: LocalDecl, sortGroup?: string): vscode.CompletionItem {
    const isInstance = this.isInstanceDecl(decl);
    const item = new vscode.CompletionItem(
      { label: decl.name, description: isInstance ? "local instance" : "local tag" },
      isInstance ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Variable
    );
    item.detail = decl.typeText;
    if (sortGroup) item.sortText = `${sortGroup}${decl.name}`;
    return item;
  }

  /**
   * The list offered for a BARE (unprefixed, unquoted) identifier inside an
   * executable body. That position accepts three genuinely different kinds
   * of name, so all three are offered -- and, because they LOOK identical
   * once typed, each row says which kind it is:
   *
   *   - this block's own declared tags, which TIA's importer resolves
   *     without the `#` (see parser/s7dclParser.ts's `LocalTagNames`) --
   *     `Variable`/`Class` icon, "local tag"/"local instance";
   *   - workspace blocks callable by bare name (`Helper(...)`) --
   *     `Function`/`Class`/`Module` icon, the block type as the note;
   *   - the Siemens instruction catalog -- `Function` icon, "TIA
   *     instruction".
   *
   * `sortText` groups them in that order (most-local first) rather than
   * interleaving ~500 catalog instructions with the handful of names
   * actually in scope. Every row keeps `filterText` at the bare name so
   * typing still filters on what the user sees.
   */
  private bareIdentifierCompletions(document: vscode.TextDocument, position: vscode.Position, text: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    if (document.languageId === "s7scl") {
      for (const decl of this.declsInScope(text, position)) items.push(this.localTagItem(decl, "0_"));
      for (const block of this.blockIndex.values()) {
        // A DATA_BLOCK is only ever referenced in QUOTED form, never called
        // bare -- `externalBlockCompletions` (the `"` trigger) covers it.
        if (block.blockType === "DATA_BLOCK") continue;
        const typeLabel = block.blockType.replace(/_/g, " ").toLowerCase();
        const item = new vscode.CompletionItem(
          { label: block.name, description: `workspace ${typeLabel}` },
          block.blockType === "FUNCTION_BLOCK" ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Function
        );
        item.detail = typeLabel;
        item.documentation = new vscode.MarkdownString(`**${block.name}** _(${typeLabel})_\n\ndeclared in \`${block.file}\``);
        item.sortText = `1_${block.name}`;
        items.push(item);
      }
    }
    for (const item of this.instructionCompletions(document, position)) {
      // `instructionCompletions` may already have rewritten `label` to an
      // auto-instance variant ("TON (local multi-instance)") with its own
      // `filterText`; keep whichever text it settled on and just annotate
      // WHICH list this row came from.
      const label = typeof item.label === "string" ? item.label : item.label.label;
      item.label = { label, description: "TIA instruction" };
      item.filterText = item.filterText ?? label;
      item.sortText = `2_${item.filterText}`;
      items.push(item);
    }
    return items;
  }

  /**
   * Attaches "create the instance too" edits to every member completion for a
   * BARE FUNCTION_BLOCK base.
   *
   * `"FB_Pump".x` is illegal on its own -- a FUNCTION_BLOCK's members are only
   * reachable through an instance. Accepting any of these items therefore also
   * inserts a single-instance DATA_BLOCK and rewrites the base reference to it,
   * turning `"FB_Pump".x` into `"FB_Pump_DB".x` in one action. The
   * single-instance DB (rather than a local multi-instance) is used because it
   * is legal from every calling block type -- an FC/OB has no Static section.
   *
   * Returns the items unchanged if no instance could be planned, so completion
   * still works (just without the auto-fix) rather than disappearing.
   */
  private withInstanceAutoCreate(
    document: vscode.TextDocument,
    position: vscode.Position,
    items: vscode.CompletionItem[],
    fb: BlockInfo,
    baseStartOffset: number
  ): vscode.CompletionItem[] {
    const ctx = resolveBlockInstanceContext(document, position.line);
    if (!ctx) return items;
    const plan = buildSingleInstanceDbEdit(document, ctx, fbInstanceRef(fb.name), this.blockIndex, this.getTypeCache());
    if (!plan) return items;

    // The base token spans both quotes: `"FB_Pump"`.
    const baseRange = new vscode.Range(
      document.positionAt(baseStartOffset),
      document.positionAt(baseStartOffset + fb.name.length + 2)
    );
    const instanceEdits = [plan.edit, vscode.TextEdit.replace(baseRange, `"${plan.dbName}"`)];
    return items.map((item) => {
      item.additionalTextEdits = instanceEdits;
      item.detail = `${item.detail ?? ""} — creates "${plan.dbName}"`.trim();
      item.documentation = new vscode.MarkdownString(
        `\`"${fb.name}"\` is a FUNCTION_BLOCK type, not an instance.\n\n` +
          `Accepting this also generates \`DATA_BLOCK "${plan.dbName}"\` and points the reference at it.`
      );
      return item;
    });
  }

  /** Where a block reference's members come from.
   *
   * An INSTANCE DATA_BLOCK has no VAR section of its own, so `"R_TRIG_DB".`
   * must offer what it is an INSTANCE OF: a FUNCTION_BLOCK's interface (quoted
   * instance-of line) or an instruction's pins (unquoted / `InstructionName`
   * pragma, resolved via `listInstanceMembers` like `#inst.` already is).
   * Any other block just contributes its own vars. Mirrors the hover
   * resolution in analysis/documentIndex.ts. */
  private instanceMemberRoot(
    block: BlockInfo | undefined
  ): { ownerBlock: BlockInfo | undefined; topLevelName: string | null; preferScl?: boolean } | undefined {
    if (!block) return undefined;
    if (block.blockType === "DATA_BLOCK" && block.instanceOf) {
      if (block.instanceOf.quoted) {
        const target = this.blockIndex.get(block.instanceOf.name);
        return target ? { ownerBlock: target, topLevelName: null } : undefined;
      }
      return { ownerBlock: undefined, topLevelName: block.instructionName ?? block.instanceOf.name, preferScl: true };
    }
    return { ownerBlock: block, topLevelName: null };
  }

  /** Resolves the member source a chain step lands on. `leafName` is the
   * type's ultimate named leaf (drilled through Array/REF_TO), `topLevelName`
   * its own top-level name, `structEntries` the already-captured fields of an
   * inline STRUCT (which has no name to look anything up by). Tried in
   * specificity order: an inline STRUCT is self-describing, a workspace block
   * shadows a same-named UDT, and the instruction registry is last since its
   * "members" are the loosest match. */
  private memberSourceFor(leafName: string | null, topLevelName: string | null, structEntries?: MemberEntry[]): MemberSource | undefined {
    if (structEntries && structEntries.length > 0) {
      return { kind: "fields", label: "STRUCT", entries: structEntries };
    }
    if (leafName) {
      const block = this.blockIndex.get(leafName);
      if (block) {
        // A member typed as an instance DB hops through to what it instances.
        const root = this.instanceMemberRoot(block);
        if (root?.ownerBlock) return { kind: "block", block: root.ownerBlock };
        if (root?.topLevelName) return { kind: "instance", typeName: root.topLevelName };
        return { kind: "block", block };
      }
      const udt = lookupType(this.getTypeCache(), leafName);
      if (udt && udt.kind === "udt" && udt.members && udt.members.length > 0) {
        return { kind: "fields", label: udt.name, entries: udt.members.map(entryFromMemberRef) };
      }
    }
    // Before system-types.yaml, deliberately: a CALLABLE instance type is
    // listed in BOTH registries -- `R_TRIG` is an instance-dot instruction
    // AND a system-struct whose members are its raw memory layout
    // (`clk`/`q`). Code addresses it as an instance, so the instruction
    // registry's own parameter names win (and, in SCL, its SCL-cased
    // `CLK`/`Q` rather than the graphical `clk`/`q`). A system-struct that
    // ISN'T a callable instance type -- IEC_TIMER, ErrorStruct, TCON_Param,
    // ... -- falls through to the branch below unaffected.
    const instanceType = topLevelName ?? leafName;
    if (instanceType && listInstanceMembers(this.ruleSet, instanceType).length > 0) {
      return { kind: "instance", typeName: instanceType };
    }
    if (leafName) {
      const systemType = findSystemType(this.ruleSet, leafName);
      if (systemType?.entry.category === "system-struct" && systemType.entry.members && systemType.entry.members.length > 0) {
        return { kind: "fields", label: systemType.name, entries: systemType.entry.members.map(entryFromSystemTypeMember) };
      }
    }
    return undefined;
  }

  /** One `.member` hop off `source`, or undefined when `segment` isn't a
   * member of it. Case-insensitive throughout -- SCL identifiers are. */
  private stepMemberSource(source: MemberSource, segment: string, preferScl: boolean): MemberSource | undefined {
    if (source.kind === "block") {
      const memberVar =
        source.block.vars.get(segment) ?? [...source.block.vars.values()].find((v) => v.name.toLowerCase() === segment.toLowerCase());
      if (!memberVar) return undefined;
      const ref = memberVar.member.typeRef;
      return this.memberSourceFor(typeRefLeafName(ref), typeRefTopLevelName(ref), inlineStructEntriesOf(ref));
    }
    if (source.kind === "fields") {
      const entry = source.entries.find((e) => e.name.toLowerCase() === segment.toLowerCase());
      if (!entry) return undefined;
      return this.memberSourceFor(entry.leafName, entry.topLevelName, entry.nested);
    }
    const found = listInstanceMembers(this.ruleSet, source.typeName, preferScl).find((m) => m.name.toLowerCase() === segment.toLowerCase());
    // Only a single unambiguous pin type can carry a further `.member` step
    // -- don't guess when the registry lists several.
    if (!found || found.dataTypes.length !== 1) return undefined;
    return this.memberSourceFor(found.dataTypes[0], found.dataTypes[0]);
  }

  /** Walks any already-typed `.member` segments before the trigger dot (e.g.
   * the SECOND dot in `#fbX.someInstance.`), then emits the member list for
   * whatever it lands on. Shared by the `#tag.`, bare `tag.`, and
   * `"Quoted".` entry points. */
  private memberCompletions(
    startBlock: BlockInfo | undefined,
    startTopLevelName: string | null,
    chainRest: string[],
    preferScl = false,
    startLeafName?: string | null,
    startStructEntries?: MemberEntry[]
  ): vscode.CompletionItem[] | undefined {
    let source: MemberSource | undefined = startBlock
      ? { kind: "block", block: startBlock }
      : this.memberSourceFor(startLeafName ?? startTopLevelName, startTopLevelName, startStructEntries);

    for (const segment of chainRest) {
      if (!source) return undefined;
      source = this.stepMemberSource(source, segment, preferScl);
    }
    if (!source) return undefined;

    if (source.kind === "block") {
      const block = source.block;
      return [...block.vars.values()]
        // Same rule linter/symbolChecks.ts's `checkIllegalDotAccess`
        // enforces: a VAR_TEMP/VAR_CONSTANT member is never externally
        // exposed, and a FUNCTION has no instance data at all -- offering
        // either would complete code the linter immediately flags.
        .filter((v) => isDotAccessLegal(block.blockType, v.section))
        .map((v) => {
          const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Field);
          item.detail = typeRefToText(v.member.typeRef);
          item.documentation = new vscode.MarkdownString(`_(${v.section} of \`${block.name}\`)_`);
          return item;
        });
    }
    if (source.kind === "fields") {
      const label = source.label;
      return source.entries.map((e) => {
        const item = new vscode.CompletionItem(e.name, vscode.CompletionItemKind.Field);
        item.detail = e.typeText;
        item.documentation = new vscode.MarkdownString(`_(member of \`${label}\`)_`);
        return item;
      });
    }
    const members = listInstanceMembers(this.ruleSet, source.typeName, preferScl);
    if (members.length === 0) return undefined;
    return members.map((m) => {
      const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Property);
      item.detail = m.dataTypes.join(" / ");
      item.documentation = new vscode.MarkdownString(`via \`${m.source}\``);
      return item;
    });
  }

  /** The identifier run immediately before `offset`, at the source-file
   * root -- e.g. `fun|` -> the range spanning `fun`. Zero-width (a pure
   * insertion, nothing replaced) when the cursor isn't directly attached to
   * one, e.g. a blank line. Every `topLevelCompletions` item uses this as
   * its own replace range so accepting one REPLACES whatever prefix the
   * user already typed instead of inserting the template alongside it
   * (`fun` -> the full `FUNCTION_BLOCK` template, never `funFUNCTION_BLOCK
   * "..."`) -- the one piece of "duplicate/malformed-context protection"
   * that's about the completion ITEM'S own edit rather than about whether
   * to offer these items at all (that part is entirely
   * analysis/sclCompletionContext.ts's `{kind: "root"}` gating). */
  private rootPrefixRange(document: vscode.TextDocument, offset: number): vscode.Range {
    const text = document.getText();
    let start = offset;
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
    return new vscode.Range(document.positionAt(start), document.positionAt(offset));
  }

  /** One indentation level for a brand-new top-level block template --
   * sniffed from this SAME document's own first existing VAR-section (or
   * inline STRUCT) line, if any (the file's own already-established
   * convention, the same "trust the file itself first" preference
   * `indentInfo` already applies for a declaration inside an EXISTING
   * block); falling back to the active editor's own tab/space settings
   * (only when this document is the one currently open), and finally to
   * three spaces -- see this request's own "Formatting" section for why
   * three spaces specifically (matches the fixture corpus's own real TIA-
   * exported fixtures, e.g. distributed-process-control.scl). Deliberately a SEPARATE sniff
   * from `indentInfo`: that one measures the gap between two ALREADY-
   * PRESENT lines relative to the CURRENT line's own indentation, which
   * has no meaning at the root (the current line, by definition, has
   * nothing enclosing it to measure a relative gap against). */
  private topLevelIndentUnit(document: vscode.TextDocument): string {
    for (let line = 0; line < document.lineCount; line++) {
      const m = /^([ \t]+)(?:VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_CONSTANT|VAR\b|STRUCT)\b/i.exec(document.lineAt(line).text);
      if (m) return m[1];
    }
    const editorOptions = vscode.window?.activeTextEditor?.document === document ? vscode.window.activeTextEditor.options : undefined;
    if (typeof editorOptions?.tabSize === "number" || typeof editorOptions?.insertSpaces === "boolean") {
      const insertSpaces = typeof editorOptions?.insertSpaces === "boolean" ? editorOptions.insertSpaces : true;
      const tabSize = typeof editorOptions?.tabSize === "number" ? editorOptions.tabSize : 3;
      return insertSpaces ? " ".repeat(tabSize) : "\t";
    }
    return "   ";
  }

  /** The seven source-file-root block templates (see this request's own
   * spec) -- offered only at `{kind: "root"}` (analysis/
   * sclCompletionContext.ts, gated to the true source-file root: outside
   * every FUNCTION_BLOCK/FUNCTION/ORGANIZATION_BLOCK/DATA_BLOCK/TYPE, never
   * inside one of their headers/attributes/declaration sections/bodies, or
   * an incomplete one whose own closer hasn't been typed yet). Each
   * template's OWN name -- `${1:ExampleFB}` etc. -- is immediately
   * selected on insertion (VS Code's own standard snippet-tabstop
   * behavior: the FIRST placeholder is pre-selected the moment the
   * snippet lands, so the very next keystroke replaces it outright, no
   * manual select/delete/Tab required); later tab stops (return type,
   * referenced FB/UDT name, final body position) follow via `${2:...}`/
   * `$0`. `rootPrefixRange` on every item replaces whatever's already been
   * typed (`fun` -> the chosen template, never `funFUNCTION_BLOCK ...`).
   *
   * Casing: Siemens keywords are emitted in uppercase, matching the convention
   * used by the supported source formats. Per-document casing detection is not
   * implemented. */
  private topLevelCompletions(document: vscode.TextDocument, offset: number): vscode.CompletionItem[] {
    const range = this.rootPrefixRange(document, offset);
    const ind = this.topLevelIndentUnit(document);

    const make = (label: string, kind: vscode.CompletionItemKind, detail: string, lines: string[]): vscode.CompletionItem => {
      const item = new vscode.CompletionItem(label, kind);
      item.range = range;
      item.detail = detail;
      item.insertText = new vscode.SnippetString(lines.join("\n"));
      return item;
    };

    return [
      make("FUNCTION_BLOCK", vscode.CompletionItemKind.Class, "New FUNCTION_BLOCK (FB) declaration", [
        'FUNCTION_BLOCK "${1:ExampleFB}"',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "",
        ind + "VAR_INPUT",
        ind + "END_VAR",
        "",
        ind + "VAR_OUTPUT",
        ind + "END_VAR",
        "",
        ind + "VAR_IN_OUT",
        ind + "END_VAR",
        "",
        ind + "VAR",
        ind + "END_VAR",
        "",
        ind + "VAR_TEMP",
        ind + "END_VAR",
        "",
        ind + "VAR CONSTANT",
        ind + "END_VAR",
        "",
        "BEGIN",
        "${0}",
        "END_FUNCTION_BLOCK",
      ]),
      make("FUNCTION", vscode.CompletionItemKind.Function, "New FUNCTION (FC) declaration", [
        'FUNCTION "${1:ExampleFC}" : ${2:Void}',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "",
        ind + "VAR_INPUT",
        ind + "END_VAR",
        "",
        ind + "VAR_OUTPUT",
        ind + "END_VAR",
        "",
        ind + "VAR_IN_OUT",
        ind + "END_VAR",
        "",
        ind + "VAR_TEMP",
        ind + "END_VAR",
        "",
        ind + "VAR CONSTANT",
        ind + "END_VAR",
        "",
        "BEGIN",
        "${0}",
        "END_FUNCTION",
      ]),
      make("ORGANIZATION_BLOCK", vscode.CompletionItemKind.Module, "New ORGANIZATION_BLOCK (OB) declaration", [
        'ORGANIZATION_BLOCK "${1:ExampleOB}"',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "",
        ind + "VAR_TEMP",
        ind + "END_VAR",
        "",
        ind + "VAR CONSTANT",
        ind + "END_VAR",
        "",
        "BEGIN",
        "${0}",
        "END_ORGANIZATION_BLOCK",
      ]),
      make("DATA_BLOCK — Global", vscode.CompletionItemKind.Module, "New global DATA_BLOCK with its own VAR structure", [
        'DATA_BLOCK "${1:ExampleDB}"',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "",
        ind + "VAR",
        "${0}",
        ind + "END_VAR",
        "",
        "BEGIN",
        "",
        "END_DATA_BLOCK",
      ]),
      make("DATA_BLOCK — FB Instance", vscode.CompletionItemKind.Module, "New instance DATA_BLOCK for an existing FUNCTION_BLOCK", [
        'DATA_BLOCK "${1:ExampleInstanceDB}"',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "NON_RETAIN",
        '"${2:ReferencedFB}"',
        "BEGIN",
        "${0}",
        "END_DATA_BLOCK",
      ]),
      make("DATA_BLOCK — PLC Data Type", vscode.CompletionItemKind.Module, "New DATA_BLOCK structured from an existing PLC data type (UDT)", [
        'DATA_BLOCK "${1:ExampleTypedDB}"',
        "{ S7_Optimized_Access := 'TRUE' }",
        "VERSION : 0.1",
        "NON_RETAIN",
        '"${2:ReferencedType}"',
        "BEGIN",
        "${0}",
        "END_DATA_BLOCK",
      ]),
      make("TYPE — PLC Data Type", vscode.CompletionItemKind.Struct, "New PLC data type (UDT) declaration", [
        'TYPE "${1:ExampleType}"',
        "VERSION : 0.1",
        "",
        ind + "STRUCT",
        "${0}",
        ind + "END_STRUCT;",
        "",
        "END_TYPE",
      ]),
    ];
  }

  /** Datatype completions for a FUNCTION header's own return-type position
   * (`FUNCTION "Name" : |`) -- see analysis/sclCompletionContext.ts's
   * `classifyFunctionReturnType`. Every built-in/system/opaque name legal
   * EVERYWHERE (section-legality.yaml's own `allSections.datatypes` --
   * the same "legal in every VAR_* section" universe `legalTypeNamesForSection`
   * layers its own per-section overlay on top of) plus `Void`, a function's
   * own "no return value" marker -- not a normal VAR-section datatype at
   * all, so it's never part of that universe on its own. No UDT/array
   * support here: a function's return type is always a single bare name in
   * this grammar, never an inline `Struct` or `Array`. `allSections`
   * necessarily includes some names (HW_/OB_/EVENT_-prefixed handles) that
   * are unlikely real function return types in practice -- reusing that list
   * as-is (rather than inventing a narrower one) avoids fabricating a new,
   * unsourced curation of "which of these Siemens actually allows as a
   * return type", matching the fixture corpus's own "don't guess" discipline. */
  private functionReturnTypeCompletions(document: vscode.TextDocument, text: string, offset: number, anchorEnd: number, identStart: number | null): vscode.CompletionItem[] {
    const start = identStart ?? offset;
    const needsLeadingSpace = start === anchorEnd;
    const leadingSpace = needsLeadingSpace ? " " : "";
    const range = new vscode.Range(document.positionAt(start), document.positionAt(offset));

    const names = ["Void", ...this.ruleSet.sectionLegality.allSections.datatypes];
    // The prefix-only context resolver cannot distinguish a complete return
    // type from an in-progress identifier when the cursor sits at that
    // identifier's end: both `Void|` and `Re|` end in one ident token. Use
    // the rule-backed candidate set here to make that semantic distinction,
    // and tokenize only the suffix to see whether the header continues. This
    // preserves completion for an exact type at EOF while closing the slot
    // once VERSION/a pragma/BEGIN (or any other real token) follows it.
    const typedIdent = identStart === null ? "" : text.slice(identStart, offset);
    const isCompleteType = names.some((name) => name.toUpperCase() === typedIdent.toUpperCase());
    const hasFollowingToken = new Lexer(text.slice(offset)).tokenize().some((token) => token.kind !== "eof");
    const identContinuesAfterCursor = /^[A-Za-z0-9_]/.test(text[offset] ?? "");
    if (isCompleteType && !identContinuesAfterCursor && hasFollowingToken) return [];
    return names.map((name) => {
      const isVoid = name === "Void";
      const isBase = !isVoid && !!this.ruleSet.baseTypes[name];
      const item = new vscode.CompletionItem(name, isVoid ? vscode.CompletionItemKind.Keyword : isBase ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Interface);
      item.range = range;
      item.insertText = `${leadingSpace}${name}`;
      item.detail = isVoid ? "no return value" : isBase ? "base type" : "system/opaque type";
      return item;
    });
  }

  /** Referenced-symbol completions for an FB-instance or PLC-data-type-
   * based DATA_BLOCK's own quoted slot (`NON_RETAIN` then `"|"`) -- see
   * analysis/sclCompletionContext.ts's `classifyDataBlockInstanceRef`.
   * Both templates land the cursor on the EXACT same syntactic position (a
   * DATA_BLOCK's structure can be inherited from either an existing
   * FUNCTION_BLOCK or an existing PLC data type, and nothing in the
   * resulting TEXT tells the two apart -- `topLevelCompletions`'s own two
   * templates differ only in which placeholder word they seed this slot
   * with), so which candidate set to offer is decided from `textSoFar`:
   * `topLevelCompletions` seeds the FB-instance template's slot with the
   * literal word `ReferencedFB` and the typed-DB template's with
   * `ReferencedType` -- words a real user would never type themselves --
   * specifically so this check can tell the two apart the MOMENT the
   * suggestion list first pops up on landing at the tab stop, before
   * either default has been typed over. Once the user HAS typed a real
   * name over it, that signal is gone (there is no other way to recover
   * "which template produced this position" from a stateless
   * (document, position) completion request -- see this request's own
   * response for why that's a genuine architectural limit, not an
   * oversight), so both candidate sets are offered together -- still
   * correctly excluding FUNCTION/ORGANIZATION_BLOCK/DATA_BLOCK names
   * either way, since neither is ever a legal DATA_BLOCK structure
   * source. */
  private dataBlockInstanceRefCompletions(document: vscode.TextDocument, offset: number, identStart: number, textSoFar: string): vscode.CompletionItem[] {
    const text = document.getText();
    const hasClosingQuote = text.slice(offset, offset + 1) === '"';
    const range = new vscode.Range(document.positionAt(identStart), document.positionAt(offset));

    const fbNames = this.blockIndex
      .values()
      .filter((b) => b.blockType === "FUNCTION_BLOCK")
      .map((b) => b.name);
    const udtNames = [...this.getTypeCache().types.entries()].filter(([, info]) => info.kind === "udt").map(([name]) => name);

    const candidates: { name: string; kind: vscode.CompletionItemKind; detail: string }[] =
      textSoFar === "ReferencedFB"
        ? fbNames.map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "function block (FB)" }))
        : textSoFar === "ReferencedType"
        ? udtNames.map((name) => ({ name, kind: vscode.CompletionItemKind.Struct, detail: "PLC data type (UDT)" }))
        : [
            ...fbNames.map((name) => ({ name, kind: vscode.CompletionItemKind.Class, detail: "function block (FB)" })),
            ...udtNames.map((name) => ({ name, kind: vscode.CompletionItemKind.Struct, detail: "PLC data type (UDT)" })),
          ];

    return candidates.map(({ name, kind, detail }) => {
      const item = new vscode.CompletionItem(name, kind);
      item.range = range;
      item.insertText = `${name}${hasClosingQuote ? "" : '"'}`;
      item.detail = detail;
      return item;
    });
  }

  /** Dispatches a declaration-section cursor position (see
   * analysis/sclCompletionContext.ts's own `DeclSubContext`) to the right
   * datatype-completion behavior -- or no completions at all for a
   * position nothing should ever be suggested at (still typing the
   * member name, inside `Array[...]`'s own brackets, between `]` and
   * `of`, or a type expression that's already complete). */
  private declarationCompletions(document: vscode.TextDocument, offset: number, section: SclSection, decl: DeclSubContext): vscode.CompletionItem[] {
    switch (decl.kind) {
      case "name":
      case "array-bounds":
      case "awaiting-of":
      case "closed":
        return [];
      case "after-array-keyword": {
        // `Array` was typed out manually (not accepted from the "Array"
        // suggestion below, which already bundles this same scaffold into
        // its own insertText) -- still offer the bounds+`of` continuation.
        const item = new vscode.CompletionItem("[lo..hi] of ...", vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString("[${1:1}..${2:10}] of ${0}");
        item.detail = "Array bounds and element type";
        return [item];
      }
      case "bare-type":
        return this.bareTypeCompletions(document, offset, section, decl);
      case "quoted-type":
        return this.quotedTypeCompletions(document, offset, section, decl);
    }
  }

  /** Looks a SHORT way past `offset` (a bounded re-lex, not the
   * "tokenize-only-up-to-cursor" restriction analysis/sclCompletionContext.ts
   * itself applies -- there's no unterminated-string hazard looking
   * FORWARD by a fixed, small window) for an already-typed `;` immediately
   * following the in-progress type expression -- comment/whitespace-aware
   * (a real re-lex, not a raw-text regex), so a completion never inserts a
   * SECOND semicolon next to one the user already typed. Deliberately
   * does NOT extend the replace range to swallow that existing `;` --
   * this only decides whether to APPEND one; the one already there (past
   * the cursor, untouched by the edit) stays exactly where it is. */
  private hasTrailingSemicolon(text: string, offset: number): boolean {
    const forward = new Lexer(text.slice(offset, offset + 200)).tokenize();
    const first = forward[0];
    return !!first && first.kind === "punct" && first.text === ";";
  }

  /** Bare (non-quoted) datatype completions -- built-in/system/opaque type
   * names legal in `section` (section-legality.yaml via
   * `legalTypeNamesForSection`), replacing whatever's already been typed
   * (`decl.identStart`, or a pure insertion at the cursor when nothing has)
   * through any already-present `;` (never duplicated), with exactly one
   * leading space when `decl.anchorEnd` (right after `:`/`of`) is directly
   * adjacent to the replacement start (nothing -- not even whitespace --
   * typed there yet). `Array` gets its own snippet inserting the
   * `[lo..hi] of ` scaffold instead of a bare `Array;` (illegal on its
   * own), and is excluded entirely from an array's OWN element-type
   * position (`decl.afterArrayOf` -- nested arrays are illegal, see
   * composition-rules.yaml's `array.elementType.nestedArraysForbidden`). */
  private bareTypeCompletions(document: vscode.TextDocument, offset: number, section: SclSection, decl: Extract<DeclSubContext, { kind: "bare-type" }>): vscode.CompletionItem[] {
    const text = document.getText();
    const { names } = legalTypeNamesForSection(this.ruleSet, section);
    const identStart = decl.identStart ?? offset;
    const needsLeadingSpace = identStart === decl.anchorEnd;
    const hasSemicolon = this.hasTrailingSemicolon(text, offset);
    const range = new vscode.Range(document.positionAt(identStart), document.positionAt(offset));
    const leadingSpace = needsLeadingSpace ? " " : "";

    const items: vscode.CompletionItem[] = [];
    for (const name of names) {
      if (name === "Array") {
        if (decl.afterArrayOf) continue; // nested array -- illegal, never offered
        const item = new vscode.CompletionItem("Array", vscode.CompletionItemKind.Class);
        item.range = range;
        item.insertText = new vscode.SnippetString(`${leadingSpace}Array[\${1:1}..\${2:10}] of \${0}`);
        item.detail = "Array type";
        items.push(item);
        continue;
      }
      if (name === "Struct") {
        const { indentUnit } = this.indentInfo(document, offset);
        const item = new vscode.CompletionItem("Struct", vscode.CompletionItemKind.Struct);
        item.range = range;
        // VS Code auto-prepends the CURRENT line's own indentation to
        // every continuation line of a multi-line completion snippet
        // BEFORE inserting this literal text -- so each line here is
        // written RELATIVE to that already-applied baseline, not
        // absolute: the member line only adds ONE further indentUnit
        // (baseline + indentUnit = one level deeper than the declaration
        // itself), and the `END_STRUCT;` line adds NOTHING (baseline
        // alone already lines it up under the declaration). Including
        // the baseline indentation AGAIN here (as an earlier version of
        // this did) double-indents every line instead. `$0` lands right
        // after the first member's own `;` -- pressing Enter there
        // naturally continues typing more members, rather than leaving
        // the cursor stranded past `END_STRUCT;`.
        item.insertText = new vscode.SnippetString(`${leadingSpace}Struct\n${indentUnit}\${1:member} : \${2:Bool};$0\nEND_STRUCT;`);
        item.detail = "Inline STRUCT type";
        items.push(item);
        continue;
      }
      const item = new vscode.CompletionItem(name, this.ruleSet.baseTypes[name] ? vscode.CompletionItemKind.Class : vscode.CompletionItemKind.Interface);
      item.range = range;
      item.insertText = `${leadingSpace}${name}${hasSemicolon ? "" : ";"}`;
      item.detail = this.ruleSet.baseTypes[name] ? "base type" : "system/opaque type";
      items.push(item);
    }
    return items;
  }

  /** ONE indent level's worth of whitespace, for a nested member line one
   * level deeper than the current declaration -- deliberately NOT paired
   * with the current line's own absolute indentation, because VS Code
   * ITSELF already auto-prepends that to every continuation line of a
   * multi-line completion snippet before inserting this literal text (see
   * `bareTypeCompletions`'s own `Struct` case, the only caller); returning
   * it here too would double it up.
   *
   * Prefers sniffing the width DIRECTLY from this file's own existing
   * declarations -- the nearest preceding, less-indented, non-blank line
   * is (in any well-formed VAR section or inline STRUCT) the enclosing
   * construct's own line, so the plain textual difference between the two
   * indents already IS one real indent level here, matching "the same
   * indentation width as existing declarations in the current VAR
   * section" more literally than a generic editor setting could (a file
   * can use a different width than the active editor's own default/
   * detected one). Falls back to the active editor's tab/space settings
   * (when this document is the one currently open) if nothing usable is
   * found in the file itself (e.g. this is the very first, top-level
   * declaration), and finally to a bare tab-or-4-spaces guess if neither
   * source has an answer (e.g. this exact method running outside a real
   * VS Code window, as in the fixture corpus's own Node-based test scripts). */
  private indentInfo(document: vscode.TextDocument, offset: number): { indentUnit: string } {
    const position = document.positionAt(offset);
    const currentIndent = /^[ \t]*/.exec(document.lineAt(position.line).text)?.[0] ?? "";

    for (let line = position.line - 1; line >= 0; line--) {
      const lineText = document.lineAt(line).text;
      if (lineText.trim().length === 0) continue;
      const lineIndent = /^[ \t]*/.exec(lineText)?.[0] ?? "";
      if (lineIndent.length >= currentIndent.length) continue; // not shallower -- keep looking
      if (currentIndent.startsWith(lineIndent)) return { indentUnit: currentIndent.slice(lineIndent.length) };
      break; // shallower but a different whitespace mix -- don't guess, fall through
    }

    const editorOptions = vscode.window?.activeTextEditor?.document === document ? vscode.window.activeTextEditor.options : undefined;
    if (typeof editorOptions?.tabSize === "number" || typeof editorOptions?.insertSpaces === "boolean") {
      const insertSpaces = typeof editorOptions?.insertSpaces === "boolean" ? editorOptions.insertSpaces : !currentIndent.includes("\t");
      const tabSize = typeof editorOptions?.tabSize === "number" ? editorOptions.tabSize : 4;
      return { indentUnit: insertSpaces ? " ".repeat(tabSize) : "\t" };
    }

    return { indentUnit: currentIndent.includes("\t") ? "\t" : "    " };
  }

  /** Quoted PLC-data-type (UDT) completions -- every `kind: "udt"` entry
   * the workspace type cache knows about (never the elementary/system/
   * opaque names ALSO seeded into that same cache, see
   * cache/typeCache.ts's own `seed`), gated behind `section`'s own
   * `allowsUdt` (e.g. refused entirely for VAR_CONSTANT). Closes the quote
   * and appends `;` (unless already present, same
   * `lookaheadSemicolon` rule `bareTypeCompletions` uses) -- and, on the
   * rarer path where the user's own opening `"` sits directly against
   * `:`/`of` with no space at all, inserts that missing leading space too
   * via `additionalTextEdits` (it sits BEFORE the quote character itself,
   * outside this item's own replace range, so it can't be folded into the
   * same edit). */
  private quotedTypeCompletions(document: vscode.TextDocument, offset: number, section: SclSection, decl: Extract<DeclSubContext, { kind: "quoted-type" }>): vscode.CompletionItem[] {
    const { allowsUdt } = legalTypeNamesForSection(this.ruleSet, section);
    if (!allowsUdt) return [];

    const text = document.getText();
    const typeCache = this.getTypeCache();
    const hasSemicolon = this.hasTrailingSemicolon(text, offset);
    const range = new vscode.Range(document.positionAt(decl.identStart), document.positionAt(offset));
    const needsLeadingSpace = decl.quoteStart === decl.anchorEnd;
    const leadingSpaceEdits = needsLeadingSpace ? [vscode.TextEdit.insert(document.positionAt(decl.anchorEnd), " ")] : undefined;

    const items: vscode.CompletionItem[] = [];
    for (const [name, info] of typeCache.types) {
      if (info.kind !== "udt") continue;
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Struct);
      item.range = range;
      item.insertText = `${name}"${hasSemicolon ? "" : ";"}`;
      item.detail = "PLC data type (UDT)";
      if (leadingSpaceEdits) item.additionalTextEdits = leadingSpaceEdits;
      items.push(item);
    }
    return items;
  }

  /** Every catalog instruction name callable as a bare `Name(...)` --
   * `ruleSet.sclInstructions` (dedicated SCL entries, SCL calling
   * convention) first for an `.scl` document, `ruleSet.instructions`
   * (shared/FBD-cased registry) as the rest -- same precedence
   * linter/sclInstructionChecks.ts's `findEntry` and
   * analysis/documentIndex.ts's `findSclInstruction` already use, so the
   * SAME name resolves to the SAME entry a user would see on hover. A
   * non-SCL document (.s7dcl/.s7udt) only ever calls through
   * `ruleSet.instructions` -- no dedicated SCL entry is reachable there.
   *
   * For an `.scl` document, a shared-registry entry restricted to a
   * DIFFERENT language (`entry.language` set and not containing `"SCL"` --
   * e.g. `MC_POWER`'s shared entry, confirmed `language: [LAD, FBD]` via
   * 12c-motion-axis-LAD-FBD.yaml's own `$fileLanguage`) is skipped
   * entirely, even when no dedicated SCL entry of that exact name/casing
   * already claimed the slot -- otherwise a LAD/FBD-only instruction shows
   * up in SCL's own completion list purely because its shared entry has a
   * DIFFERENT key casing than its SCL sibling (`MC_POWER` vs `MC_Power`),
   * which the plain `byName.has(name)` case-sensitive check alone can't
   * catch. Same `instruction-wrong-language` rule `checkCall` already
   * enforces for a real call -- this just keeps the completion list from
   * ever suggesting something that check would immediately flag.
   *
   * For an `.scl` document, an entry whose `callShape` is `instance-dot`
   * (e.g. MC_Power, TON, R_TRIG -- see linter/sclInstructionChecks.ts's own
   * `instruction-needs-instance` diagnostic for why a BARE call to one of
   * these is illegal) additionally declares a real instance as a side
   * effect of accepting it -- same `additionalTextEdits` mechanism VS
   * Code's own TypeScript completions use for auto-import. Two shapes,
   * matching the two Quick Fix actions instanceQuickFixProvider.ts offers.
   * Both a distinct `CompletionItemKind` (icon) AND a distinct label
   * suffix mark each one -- relying on the icon alone reads as "just
   * another instruction" at a glance, so the label itself also says which
   * of the two (or that it's either, rather than a plain call) a given row
   * is: `Constructor` + `" (local multi-instance)"` for "declares a local
   * instance", `Module` + `" (single-instance DB)"` for "declares a
   * DATA_BLOCK" (same kind `externalBlockCompletions` below already uses
   * for an actual DATA_BLOCK). Single-instance DB generation is legal for
   * ANY instance-dot entry with a confirmed `instanceType` -- unlike
   * multi-instance, it isn't restricted to a registry-confirmed subset
   * (see instanceQuickFix.ts's `buildSingleInstanceDbEdit`); its own
   * `S7_Optimized_Access` pragma is read live off the CALLING block's own
   * header rather than looked up per instruction, so there's nothing left
   * to guess that would justify withholding the option:
   *   - Inside a FUNCTION_BLOCK, the plain `name` item declares a local
   *     multi-instance (insertText becomes `#<generatedName>`,
   *     additionalTextEdits inserts its VAR-section declaration), and a
   *     SECOND, separately-labeled item for the single-instance DB
   *     alternative is added alongside it.
   *   - Inside a FUNCTION/ORGANIZATION_BLOCK (no Static section a
   *     multi-instance could live in), the plain `name` item instead
   *     declares a single-instance DB directly (insertText becomes
   *     `"<generatedDbName>"`).
   * See instanceQuickFix.ts's own header for the exact shapes produced.
   * The enclosing block's context is resolved ONCE per completion request
   * (`resolveBlockInstanceContext`), not once per candidate entry, so this
   * doesn't re-scan the document per instruction. */
  private instructionCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const isScl = document.languageId === "s7scl";
    const byName = new Map<string, InstructionEntry>();
    if (isScl) {
      for (const [name, entry] of Object.entries(this.ruleSet.sclInstructions)) byName.set(name, entry);
    }
    for (const [name, entry] of Object.entries(this.ruleSet.instructions)) {
      if (byName.has(name)) continue;
      if (isScl && entry.language && !entry.language.includes("SCL")) continue; // e.g. a LAD/FBD-only entry -- never callable from SCL, regardless of casing
      byName.set(name, entry);
    }

    const instanceCtx = isScl ? resolveBlockInstanceContext(document, position.line) : undefined;

    const items: vscode.CompletionItem[] = [];
    for (const [name, entry] of byName) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      item.detail = entry.family;
      item.documentation = new vscode.MarkdownString(renderInstructionHover(name, entry, isScl));

      const instRef = instructionInstanceRef(entry);
      if (instanceCtx && instRef && entry.callShape === "instance-dot") {
        const multiPlan = buildInstanceDeclarationEdit(document, instanceCtx, instRef);
        const singlePlan = buildSingleInstanceDbEdit(document, instanceCtx, instRef, this.blockIndex, this.getTypeCache());

        if (multiPlan) {
          item.kind = vscode.CompletionItemKind.Constructor;
          item.label = `${name} (local multi-instance)`;
          item.filterText = name;
          item.insertText = `#${multiPlan.instanceName}`;
          item.additionalTextEdits = [multiPlan.edit];
          item.detail = `${entry.family} -- declares local instance #${multiPlan.instanceName} : ${entry.instanceType}`;

          if (singlePlan) {
            const dbItem = new vscode.CompletionItem(`${name} (single-instance DB)`, vscode.CompletionItemKind.Module);
            dbItem.filterText = name;
            dbItem.insertText = `"${singlePlan.dbName}"`;
            dbItem.additionalTextEdits = [singlePlan.edit];
            dbItem.detail = `${entry.family} -- declares DATA_BLOCK "${singlePlan.dbName}" : ${entry.instanceType}`;
            dbItem.documentation = new vscode.MarkdownString(renderInstructionHover(name, entry, isScl));
            items.push(dbItem);
          }
        } else if (singlePlan) {
          item.kind = vscode.CompletionItemKind.Module;
          item.label = `${name} (single-instance DB)`;
          item.filterText = name;
          item.insertText = `"${singlePlan.dbName}"`;
          item.additionalTextEdits = [singlePlan.edit];
          item.detail = `${entry.family} -- declares DATA_BLOCK "${singlePlan.dbName}" : ${entry.instanceType}`;
        }
      }

      items.push(item);
    }
    return items;
  }

  /** Every workspace block name usable as a bare double-quoted `"Name"`
   * external reference -- the completion-list counterpart to
   * `analysis/symbolTable.ts`'s `resolveOperandRef` `isExternal` handling
   * and `linter/sclInstructionChecks.ts`'s `resolveCallEntry` `externalName`
   * handling (both added alongside this). Lists EVERY block regardless of
   * type -- a DATA_BLOCK, FUNCTION, or FUNCTION_BLOCK can all be a legal
   * call target (`"Name"(...)`), but only a DATA_BLOCK is legal to dot
   * INTO (`"Name".member` -- see `analysis/symbolTable.ts`'s
   * `illegal-external-block-type`, confirmed against TIA Portal itself
   * refusing to dot a bare FUNCTION_BLOCK's type name). The block's own
   * type is shown in `detail`/`documentation` so the user can judge
   * fitness for whichever shape they're actually typing, rather than the
   * list silently guessing for them. */
  private externalBlockCompletions(): vscode.CompletionItem[] {
    return this.blockIndex.values().map((block) => {
      const kind =
        block.blockType === "DATA_BLOCK"
          ? vscode.CompletionItemKind.Module
          : block.blockType === "FUNCTION_BLOCK"
          ? vscode.CompletionItemKind.Class
          : block.blockType === "FUNCTION"
          ? vscode.CompletionItemKind.Function
          : vscode.CompletionItemKind.Module;
      const item = new vscode.CompletionItem(block.name, kind);
      const typeLabel = block.blockType.replace(/_/g, " ").toLowerCase();
      item.detail = typeLabel;
      item.documentation = new vscode.MarkdownString(`**"${block.name}"** _(${typeLabel})_\n\ndeclared in \`${block.file}\``);
      return item;
    });
  }
}
