// Bridges DocumentIndex (analysis/documentIndex.ts) to VS Code's semantic
// tokens API. SCL symbols are emitted as standard VS Code semantic types so
// the user's active dark or light theme owns the presentation: `type`,
// `class`, `struct`, `function`, `variable`, `property`, and `parameter`.
// Four custom literal types (charLiteral/timeLiteral/dateLiteral/
// pointerLiteral), one boolean-literal type, and two custom
// number modifiers (radix/float) are added because no standard LSP token
// kind distinguishes e.g. a `T#10S` duration from a plain `4`. Each custom
// literal declares a standard super-type in package.json, so normal themes
// still style it. Call expressions use the standard `function` token. An
// FB/timer instance uses the `s7CallableInstance` subtype of `variable` at
// its declaration and in member access, while its FB/instruction type uses
// the `s7CallableType` subtype of `class`; this mirrors
// `object : Class` and `object.method()` in mainstream languages instead of
// flattening the object, its type, and its calls into one colour. A plain or
// UDT-backed DATA_BLOCK uses the `s7DataBlock` subtype of `variable`; an
// FB/instruction instance DB remains `s7CallableInstance`.
// A workspace PLC tag imported from a tag-table XML uses `s7PlcTag`, also a
// `variable` subtype, so global I/O/memory symbols remain visually distinct
// from local variables and DATA_BLOCKs.
// A scalar field reached through an FB/FC Input/Output/InOut path uses
// `s7InterfaceMember`, a subtype of the standard `parameter`, so the active
// theme carries the interface color through nested UDT access. Structural
// segments remain properties with the capability colors below.
// `s7Container` and `s7Indexable` are composable capability modifiers:
// a member can carry either or both without losing its variable/parameter/
// property/root-object role.
//
// Semantic tokens override TextMate scopes, so the SCL type system is modeled
// explicitly here using standard families plus inheriting S7 subtypes.
// Elementary types are grouped by meaning (temporal, integer/bit, boolean,
// float, generic/reference, and text); project UDTs are `s7UdtType`
// (`struct`), and STRUCT/Siemens system records use standard `struct`.
// `NOT` uses `operator`, matching the grammar's `keyword.operator.logical`.
import * as vscode from "vscode";
import { BlockIndex } from "../analysis/blockIndex";
import { buildDocumentIndex } from "../analysis/documentIndex";
import { TypeCacheResult } from "../cache/typeCache";
import { RuleSet } from "../rules/types";

export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "struct",
  "function",
  "variable",
  "parameter",
  "property",
  "label",
  "keyword",
  "number",
  "operator",
  "string",
  "charLiteral",
  "timeLiteral",
  "dateLiteral",
  "pointerLiteral",
  "booleanLiteral",
  "s7TemporalType",
  "s7IntegerType",
  "s7BooleanType",
  "s7FloatType",
  "s7GenericType",
  "s7TextType",
  "s7UdtType",
  "s7CallableType",
  "s7CallableInstance",
  "s7DataBlock",
  "s7PlcTag",
  "s7InterfaceMember",
] as const;
export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "readonly",
  "defaultLibrary",
  "radix",
  "float",
  "s7Container",
  "s7Indexable",
] as const;

export const semanticTokensLegend = new vscode.SemanticTokensLegend([...SEMANTIC_TOKEN_TYPES], [...SEMANTIC_TOKEN_MODIFIERS]);

const VALID_TYPES = new Set<string>(SEMANTIC_TOKEN_TYPES);
const VALID_MODIFIERS = new Set<string>(SEMANTIC_TOKEN_MODIFIERS);

export class S7dclSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(
    private readonly ruleSet: RuleSet,
    private readonly blockIndex: BlockIndex,
    private readonly getTypeCache: () => TypeCacheResult
  ) {}

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
    const index = buildDocumentIndex(document.getText(), this.ruleSet, this.blockIndex, document.uri.fsPath, "en-US", this.getTypeCache());
    const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
    for (const span of index.spans) {
      if (!VALID_TYPES.has(span.tokenType)) continue;
      const modifiers = span.tokenModifiers.filter((m) => VALID_MODIFIERS.has(m));
      const range = new vscode.Range(span.line - 1, span.startCol - 1, span.line - 1, span.startCol - 1 + span.length);
      builder.push(range, span.tokenType, modifiers);
    }
    return builder.build();
  }
}
