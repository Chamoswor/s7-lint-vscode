// Completion on "#", ".", '"', and a bare identifier. "#" (bare, or with
// some identifier characters already typed) lists every locally-declared
// tag (VAR_INPUT/OUTPUT/IN_OUT/TEMP/VAR/VAR_CONSTANT) -- the same set
// `#`-prefixed operand references in this grammar draw from. "." after a
// resolved tag lists its members: `#fbMvA.` lists FB_MotorProtection's
// VAR_INPUT/VAR_OUTPUT members, `#tonX.` lists TON_TIME's pt/et/IN/Q, etc.
// '"' (bare, or with some identifier characters already typed) lists every
// WORKSPACE BLOCK name instead -- the "global plane" a double-quoted
// external reference draws from (see analysis/symbolTable.ts's
// `resolveOperandRef` `isExternal` handling / `linter/sclInstructionChecks.
// ts`'s `resolveCallEntry` `externalName` handling, both added alongside
// this). A bare identifier (no leading `#`/`.`/`"`) lists every catalog
// INSTRUCTION name instead -- a call's own name is never `#`- or
// `"`-prefixed (`ABS(...)`, `RUNTIME(...)`), unlike an operand/instance/
// external reference, so this is the one case genuinely disjoint from the
// other three. All four reuse the exact same resolution the hover/
// definition providers already do (see analysis/documentIndex.ts's
// `localDecls`/`listInstanceMembers`/`renderInstructionHover`, and
// analysis/blockIndex.ts's own `values()`) via a text-based backward scan
// for the operand chain immediately before the cursor, rather than
// re-running the full token-cursor walk (which isn't meant to cope with
// the mid-edit, possibly-incomplete text after the cursor).
import * as vscode from "vscode";
import { BlockIndex, BlockInfo } from "../analysis/blockIndex";
import { buildDocumentIndex, listInstanceMembers, renderInstructionHover } from "../analysis/documentIndex";
import { DeclSubContext, legalTypeNamesForSection, resolveSclCompletionContext, SclSection } from "../analysis/sclCompletionContext";
import { TypeCacheResult } from "../cache/typeCache";
import { Lexer } from "../parser/lexer";
import { typeRefLeafName, typeRefToText, typeRefTopLevelName } from "../parser/typeRef";
import { InstructionEntry, RuleSet } from "../rules/types";
import { buildInstanceDeclarationEdit, buildSingleInstanceDbEdit, resolveBlockInstanceContext } from "./instanceQuickFix";

const CHAIN_BEFORE_DOT_RE = /(#[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.$/;
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

    const match = CHAIN_BEFORE_DOT_RE.exec(before);
    if (!match) {
      if (HASH_TAG_RE.test(before)) {
        const { localDecls } = buildDocumentIndex(text, this.ruleSet, this.blockIndex);
        return [...localDecls.values()].map((decl) => {
          const item = new vscode.CompletionItem(decl.name, vscode.CompletionItemKind.Variable);
          item.detail = decl.typeText;
          return item;
        });
      }
      if (QUOTED_REF_RE.test(before)) return this.externalBlockCompletions();
      if (BARE_IDENT_RE.test(before)) return this.instructionCompletions(document, position);
      return undefined;
    }

    const segments = match[1].split(".");
    const baseTag = segments[0].slice(1); // strip leading '#'
    const chainRest = segments.slice(1);

    const { localDecls } = buildDocumentIndex(text, this.ruleSet, this.blockIndex);
    const decl = localDecls.get(baseTag);
    if (!decl) return undefined;

    let ownerBlock: BlockInfo | undefined = this.blockIndex.get(decl.leafName ?? "");
    let topLevelName: string | null = decl.topLevelName;

    // Walk any already-typed `.member` segments before the trigger dot
    // (e.g. completing the SECOND dot in `#fbX.someInstance.`), same
    // one-level-per-hop resolution as the hover/definition providers.
    for (const segment of chainRest) {
      if (ownerBlock) {
        const memberVar = ownerBlock.vars.get(segment);
        if (!memberVar) return undefined;
        topLevelName = typeRefTopLevelName(memberVar.member.typeRef);
        ownerBlock = this.blockIndex.get(typeRefLeafName(memberVar.member.typeRef) ?? "");
      } else if (topLevelName) {
        const found = listInstanceMembers(this.ruleSet, topLevelName).find((m) => m.name.toLowerCase() === segment.toLowerCase());
        if (!found) return undefined;
        topLevelName = found.dataTypes.length === 1 ? found.dataTypes[0] : null;
        ownerBlock = undefined;
      } else {
        return undefined;
      }
    }

    if (ownerBlock) {
      const block = ownerBlock;
      return [...block.vars.values()].map((v) => {
        const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Field);
        item.detail = typeRefToText(v.member.typeRef);
        item.documentation = new vscode.MarkdownString(`_(${v.section} of \`${block.name}\`)_`);
        return item;
      });
    }
    if (topLevelName) {
      const members = listInstanceMembers(this.ruleSet, topLevelName);
      if (members.length === 0) return undefined;
      return members.map((m) => {
        const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Property);
        item.detail = m.dataTypes.join(" / ");
        item.documentation = new vscode.MarkdownString(`via \`${m.source}\``);
        return item;
      });
    }
    return undefined;
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

      if (instanceCtx && entry.callShape === "instance-dot") {
        const multiPlan = buildInstanceDeclarationEdit(document, instanceCtx, entry);
        const singlePlan = buildSingleInstanceDbEdit(document, instanceCtx, entry, this.blockIndex, this.getTypeCache());

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
