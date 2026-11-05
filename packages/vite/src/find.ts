import { parseSync } from 'oxc-parser';
import type { Lang } from '@pre.style/core/compiler';

export interface FoundBlock {
  // The whole block, `` css`…` ``, in the source.
  start: number;
  end: number;
  code: string;
  lang: Lang;
  // Where the block's code starts, from 1.
  line: number;
  column: number;
  // For a block with `${…}`: the text around its expressions, and where each
  // expression is.
  interpolation?: {
    strings: string[];
    expressions: { start: number; end: number; code: string; line: number; column: number }[];
  };
}

export interface FoundImport {
  start: number;
  end: number;
  // Every specifier, as written (`css as c`). `imported` is null for
  // default and namespace imports.
  specifiers: {
    imported: string | null;
    local: string;
    text: string;
    kind: 'named' | 'default' | 'namespace';
  }[];
}

// An import of a stylesheet file with `with { type: 'pre.style' }`, or a
// re-export or dynamic import of one.
export interface SheetImport {
  // The specifier and its attributes, which are replaced with a specifier
  // the plugin resolves.
  start: number;
  end: number;
  specifier: string;
  // Local bindings to the stylesheet's exports: the class each names, or
  // `*` for a namespace import.
  locals: Map<string, string>;
}

// A class exported by a stylesheet file, used as a `cn` argument.
export interface SheetClass {
  sheet: SheetImport;
  name: string;
}

export interface CnCall {
  start: number;
  end: number;
  // Static arguments: string literals, blocks, classes imported from
  // stylesheet files, and other static `cn` calls, written in the call or
  // through a `const`. Null when any argument isn't static.
  args: (string | FoundBlock | SheetClass | CnCall)[] | null;
}

export interface ScriptAnalysis {
  blocks: FoundBlock[];
  imports: FoundImport[];
  sheets: SheetImport[];
  cnCalls: CnCall[];
}

export class FindError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

const IMPORTS = new Set(['css', 'scss', 'cn']);

type Attribute = { key: { name?: string; value?: string }; value: { value: unknown } };

// Whether import attributes are `{ type: 'pre.style' }`.
const isSheet = (attributes: Attribute[] | undefined) =>
  attributes?.length === 1 &&
  (attributes[0].key.name ?? attributes[0].key.value) === 'type' &&
  attributes[0].value.value === 'pre.style';

// Text that marks a stylesheet import, for files that aren't parsed,
// including imports without bindings (`import './reset.css' with …`).
export const SHEET_IMPORT =
  /\b(?:from|import)\s*(['"])([^'"]+)\1\s*with\s*\{\s*type\s*:\s*(['"])pre\.style\3\s*,?\s*\}/g;

// Converts offsets to lines and columns, from 1.
function locator(code: string) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

type Node = { type: string; start: number; end: number; [key: string]: any };

// Calls `visit` for every node, with its parent.
function walk(
  node: unknown,
  parent: Node | null,
  visit: (node: Node, parent: Node | null) => void,
) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parent, visit);
    return;
  }
  if (node === null || typeof node !== 'object' || typeof (node as Node).type !== 'string') return;
  visit(node as Node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value !== null && typeof value === 'object')
      walk(value, node as Node, visit);
  }
}

// Whether an identifier is a reference to a binding, and not a property
// name or key.
function isReference(node: Node, parent: Node | null): boolean {
  if (parent === null) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return parent.object === node || parent.computed;
    case 'Property':
      return parent.value === node || parent.computed || parent.shorthand;
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
    case 'TSPropertySignature':
      return parent.key !== node || parent.computed;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
    default:
      return true;
  }
}

// The names a declaration's pattern binds.
function patternNames(node: Node | null, names: string[]) {
  if (node === null) return;
  switch (node.type) {
    case 'Identifier':
      names.push(node.name);
      break;
    case 'ObjectPattern':
      for (const p of node.properties as Node[])
        patternNames(p.type === 'RestElement' ? p.argument : p.value, names);
      break;
    case 'ArrayPattern':
      for (const element of node.elements as (Node | null)[]) patternNames(element, names);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, names);
      break;
    case 'RestElement':
      patternNames(node.argument, names);
      break;
    case 'TSParameterProperty':
      patternNames(node.parameter, names);
      break;
  }
}

// Where a declared name is visible: in the declaring node itself (a
// function's parameters), the nearest function (`var`), or the nearest
// block (`let`, `const`, `class`).
type Scope = 'self' | 'function' | 'block';

// The names a node declares, and where each is visible.
function declaredNames(node: Node, parent: Node | null): [string[], Scope][] {
  const names: string[] = [];
  switch (node.type) {
    case 'VariableDeclarator':
      patternNames(node.id, names);
      return [[names, parent?.kind === 'var' ? 'function' : 'block']];
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      for (const param of node.params as Node[]) patternNames(param, names);
      const id = node.id ? [node.id.name] : [];
      return [
        [names, 'self'],
        [id, node.type === 'FunctionDeclaration' ? 'block' : 'self'],
      ];
    }
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration':
    case 'TSImportEqualsDeclaration':
      if (node.id?.type === 'Identifier') names.push(node.id.name);
      return [[names, node.type === 'ClassExpression' ? 'self' : 'block']];
    case 'CatchClause':
      patternNames(node.param, names);
      return [[names, 'self']];
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return [[[node.local.name], 'block']];
  }
  return [];
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const BLOCKS = new Set([
  'Program',
  'BlockStatement',
  'StaticBlock',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'TSModuleBlock',
]);

// Expressions that only wrap a value: `(…)`, `… as const`, and so on.
const WRAPPERS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);
const unwrap = (node: Node): Node => (WRAPPERS.has(node.type) ? unwrap(node.expression) : node);

// Finds blocks in a JS or TS file, and imports of stylesheet files. Only
// `css` and `scss` imported from `@pre.style/core` mark blocks. Returns null
// when the file imports neither.
export function findInScript(filename: string, code: string): ScriptAnalysis | null {
  const { program } = parseSync(filename, code);
  const locate = locator(code);

  const imports: FoundImport[] = [];
  const sheets: SheetImport[] = [];
  // The specifier and attributes of a static import or re-export.
  const sheetImport = (statement: Node): SheetImport => {
    const last = (statement.attributes as Node[]).at(-1)!;
    return {
      start: statement.source.start,
      end: code.indexOf('}', last.end) + 1,
      specifier: statement.source.value,
      locals: new Map(),
    };
  };
  const locals = new Map<string, string>();
  for (const statement of program.body as Node[]) {
    if (
      (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') &&
      statement.source &&
      isSheet(statement.attributes)
    ) {
      sheets.push(sheetImport(statement));
      continue;
    }
    if (statement.type === 'ImportDeclaration' && isSheet(statement.attributes)) {
      const sheet = sheetImport(statement);
      if (statement.importKind !== 'type') {
        for (const specifier of statement.specifiers as Node[]) {
          if (specifier.type === 'ImportNamespaceSpecifier')
            sheet.locals.set(specifier.local.name, '*');
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
            sheet.locals.set(
              specifier.local.name,
              specifier.imported.name ?? specifier.imported.value,
            );
        }
      }
      sheets.push(sheet);
      continue;
    }
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source.value !== '@pre.style/core' ||
      statement.importKind === 'type'
    )
      continue;
    const specifiers: FoundImport['specifiers'] = [];
    for (const specifier of statement.specifiers as Node[]) {
      const text = code.slice(specifier.start, specifier.end);
      if (specifier.type !== 'ImportSpecifier') {
        const kind = specifier.type === 'ImportDefaultSpecifier' ? 'default' : 'namespace';
        specifiers.push({ imported: null, local: specifier.local.name, text, kind });
        continue;
      }
      const imported = specifier.imported.name ?? specifier.imported.value;
      specifiers.push({ imported, local: specifier.local.name, text, kind: 'named' });
      if (IMPORTS.has(imported) && specifier.importKind !== 'type')
        locals.set(specifier.local.name, imported);
    }
    imports.push({ start: statement.start, end: statement.end, specifiers });
  }

  const blocks: FoundBlock[] = [];
  const blockAt = new Map<Node, FoundBlock>();
  const cnNodes = new Set<Node>();
  // Each name's declarations, with the node it's visible in, and where
  // functions are, for `cn` arguments that name a `const`.
  const declarations = new Map<string, { node: Node; scope: Node }[]>();
  const functions: Node[] = [];
  const parents = new Map<Node, Node | null>();

  walk(program, null, (node, parent) => {
    parents.set(node, parent);
    for (const [names, scope] of declaredNames(node, parent)) {
      let visible: Node = node;
      if (scope !== 'self') {
        const stop = scope === 'block' ? BLOCKS : FUNCTIONS;
        visible = parent!;
        while (!stop.has(visible.type) && visible.type !== 'Program')
          visible = parents.get(visible)!;
      }
      for (const name of names) {
        const list = declarations.get(name) ?? [];
        list.push({ node, scope: visible });
        declarations.set(name, list);
      }
    }
    if (FUNCTIONS.has(node.type)) functions.push(node);
    // `import('./file.css', { with: { type: 'pre.style' } })`.
    if (node.type === 'ImportExpression') {
      const options = node.options as Node | null;
      const attributes = options?.properties?.find(
        (p: Node) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'with',
      )?.value;
      const typed = attributes?.properties?.map((p: Node) => ({ key: p.key, value: p.value }));
      if (
        node.source.type === 'Literal' &&
        typeof node.source.value === 'string' &&
        attributes?.type === 'ObjectExpression' &&
        isSheet(typed)
      )
        sheets.push({
          start: node.source.start,
          end: options!.end,
          specifier: node.source.value,
          locals: new Map(),
        });
      return;
    }
    if (node.type !== 'Identifier' || !locals.has(node.name) || !isReference(node, parent)) return;
    const imported = locals.get(node.name)!;
    if (imported === 'cn') {
      if (parent?.type === 'CallExpression' && parent.callee === node) cnNodes.add(parent);
      return;
    }
    if (parent?.type !== 'TaggedTemplateExpression' || parent.tag !== node) {
      const { line, column } = locate(node.start);
      throw new FindError(
        `\`${node.name}\` from pre.style can only be used as a tagged template (${node.name}\`…\`).`,
        line,
        column,
      );
    }
    const { quasi } = parent;
    // The block's code starts after the opening backtick.
    const { line, column } = locate(quasi.start + 1);
    const block: FoundBlock = {
      start: parent.start,
      end: parent.end,
      code: code.slice(quasi.start + 1, quasi.end - 1),
      lang: imported as Lang,
      line,
      column,
    };
    if (quasi.expressions.length > 0)
      block.interpolation = {
        strings: (quasi.quasis as Node[]).map((element) => element.value.raw),
        expressions: (quasi.expressions as Node[]).map((expression) => ({
          start: expression.start,
          end: expression.end,
          code: code.slice(expression.start, expression.end),
          ...locate(expression.start),
        })),
      };
    blocks.push(block);
    blockAt.set(parent, block);
  });

  if (locals.size === 0 && sheets.length === 0) return null;

  // A block's class string isn't a value for another block's `${…}`.
  for (const { interpolation } of blocks)
    for (const expression of interpolation?.expressions ?? [])
      for (const inner of blocks)
        if (expression.start <= inner.start && inner.end <= expression.end)
          throw new FindError(
            "A block can't be used in another block's `${…}`. To combine blocks, use `cn`.",
            inner.line,
            inner.column,
          );

  // The stylesheet import a local name is bound to.
  const find = (local: string) => sheets.find((sheet) => sheet.locals.has(local));
  // A class imported from a stylesheet file: a named import, or a member of
  // a namespace import.
  const sheetClass = (arg: Node): SheetClass | null => {
    if (arg.type === 'Identifier') {
      const sheet = find(arg.name);
      const name = sheet?.locals.get(arg.name);
      return sheet && name !== '*' ? { sheet, name: name! } : null;
    }
    if (arg.type === 'MemberExpression' && arg.object.type === 'Identifier') {
      const sheet = find(arg.object.name);
      if (sheet?.locals.get(arg.object.name) !== '*') return null;
      const name = arg.computed
        ? arg.property.type === 'Literal' && typeof arg.property.value === 'string'
          ? arg.property.value
          : null
        : arg.property.name;
      return name === null ? null : { sheet: sheet!, name };
    }
    return null;
  };

  // Top-level `const`s, which `cn` arguments can name.
  const consts = new Map<string, Node>();
  for (const statement of program.body as Node[]) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of declaration.declarations as Node[])
      if (declarator.id.type === 'Identifier' && declarator.init)
        consts.set(declarator.id.name, declarator);
  }
  // The `const` an identifier refers to: null when another declaration of
  // the name is visible where it's used, or when it's used before the
  // declaration outside a function, which throws at runtime.
  const within = (node: Node, outer: Node) => outer.start <= node.start && node.end <= outer.end;
  const constAt = (arg: Node): Node | null => {
    if (arg.type !== 'Identifier') return null;
    const declarator = consts.get(arg.name);
    if (declarator === undefined) return null;
    const others = declarations.get(arg.name)!.filter(({ node }) => node !== declarator);
    if (others.some(({ scope }) => within(arg, scope))) return null;
    if (arg.start < declarator.end && !functions.some((f) => within(arg, f))) return null;
    return declarator;
  };

  // `cn` calls with only string literals, blocks, stylesheet classes, and
  // other static `cn` calls can be resolved at build time.
  const cnCalls = new Map<Node, CnCall>();
  const cnCall = (node: Node): CnCall => {
    let call = cnCalls.get(node);
    if (call !== undefined) return call;
    // Set first, so a cycle through `const`s isn't static.
    call = { start: node.start, end: node.end, args: null };
    cnCalls.set(node, call);
    const args: CnCall['args'] = [];
    for (const written of node.arguments as Node[]) {
      const declarator = constAt(written);
      const arg = unwrap(declarator?.init ?? written);
      const sheet = sheetClass(written);
      if (arg.type === 'Literal' && typeof arg.value === 'string') args.push(arg.value);
      else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0)
        args.push(arg.quasis[0].value.cooked);
      // A block with `${…}` isn't known until it runs.
      else if (blockAt.has(arg) && !blockAt.get(arg)!.interpolation) args.push(blockAt.get(arg)!);
      else if (sheet !== null) args.push(sheet);
      // Only through a `const`: a call written inside another isn't
      // replaced separately.
      else if (declarator !== null && cnNodes.has(arg) && cnCall(arg).args !== null)
        args.push(cnCall(arg));
      else return call;
    }
    call.args = args;
    return call;
  };
  for (const node of cnNodes) cnCall(node);

  return { blocks, imports, sheets, cnCalls: [...cnCalls.values()] };
}

const HTML_BLOCK = /\b(s?css)`([^`]*)`/g;

// Finds blocks in HTML by text matching, since HTML can't import anything.
export function findInHtml(code: string): FoundBlock[] {
  const locate = locator(code);
  const blocks: FoundBlock[] = [];
  for (const match of code.matchAll(HTML_BLOCK)) {
    const start = match.index;
    const { line, column } = locate(start + match[1].length + 1);
    blocks.push({
      start,
      end: start + match[0].length,
      code: match[2],
      lang: match[1] as Lang,
      line,
      column,
    });
  }
  return blocks;
}

const COMPONENT_TAG = /\b(s?css)`/g;

// The offset after the `}` that ends an expression starting at `from`, skipping
// strings, comments, and nested templates and braces. -1 if it doesn't end.
function expressionEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return i + 1;
      depth--;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < code.length && code[i] !== ch && code[i] !== '\n'; i++)
        if (code[i] === '\\') i++;
    } else if (ch === '`') {
      const end = templateEnd(code, i + 1, []);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '/' && code[i + 1] === '/') {
      const newline = code.indexOf('\n', i);
      if (newline === -1) return -1;
      i = newline;
    } else if (ch === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      if (close === -1) return -1;
      i = close + 1;
    }
  }
  return -1;
}

// The closing backtick of a template starting at `from`, or -1. Each `${…}` is
// added to `expressions`, without its `${` and `}`.
function templateEnd(code: string, from: number, expressions: [number, number][]): number {
  for (let i = from; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === '`') return i;
    else if (code[i] === '$' && code[i + 1] === '{') {
      const end = expressionEnd(code, i + 2);
      if (end === -1) return -1;
      expressions.push([i + 2, end - 1]);
      i = end - 1;
    }
  }
  return -1;
}

// Finds blocks in an Astro component by text matching, since it isn't a script
// until Astro compiles it. Unlike HTML, its blocks can have `${…}`, in client
// scripts, so their expressions are followed, including nested templates.
export function findInComponent(code: string): FoundBlock[] {
  const locate = locator(code);
  const blocks: FoundBlock[] = [];
  const tag = new RegExp(COMPONENT_TAG);
  for (let match = tag.exec(code); match !== null; match = tag.exec(code)) {
    const contentStart = match.index + match[0].length;
    const ranges: [number, number][] = [];
    const close = templateEnd(code, contentStart, ranges);
    if (close === -1) continue;
    const block: FoundBlock = {
      start: match.index,
      end: close + 1,
      code: code.slice(contentStart, close),
      lang: match[1] as Lang,
      ...locate(contentStart),
    };
    if (ranges.length > 0) {
      const strings: string[] = [];
      let at = contentStart;
      for (const [start, end] of ranges) {
        strings.push(code.slice(at, start - 2));
        at = end + 1;
      }
      strings.push(code.slice(at, close));
      block.interpolation = {
        strings,
        expressions: ranges.map(([start, end]) => ({
          start,
          end,
          code: code.slice(start, end),
          ...locate(start),
        })),
      };
    }
    blocks.push(block);
    tag.lastIndex = close + 1;
  }
  return blocks;
}

// Moves each block's line and column to where it's written in `source`, the
// file a script was compiled from, such as an Astro component. Compilers
// copy blocks unchanged, so each is matched to the next unused block in
// `source` with the same code. Blocks it can't find keep their positions.
export function locateIn(blocks: FoundBlock[], source: string): void {
  const unused = findInComponent(source);
  for (const found of blocks) {
    const index = unused.findIndex((b) => b.lang === found.lang && b.code === found.code);
    if (index === -1) continue;
    const [match] = unused.splice(index, 1);
    found.line = match.line;
    found.column = match.column;
  }
}
