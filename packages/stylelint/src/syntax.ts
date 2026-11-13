import postcss, {
  Document,
  Input,
  type AnyNode,
  type Builder,
  type ProcessOptions,
  type Root,
  type Rule,
  type Syntax,
} from 'postcss';
import postcssScss from 'postcss-scss';
import type { Lang } from '@pre.style/core/compiler';
import { fileKind, findBlocks } from './blocks.ts';

// The selector Stylelint sees for the rule each block is wrapped in. A
// block's top level is the inside of a rule, and its class is a single
// class, so nested selectors (`&:hover`) resolve as they do in the build.
// It's never written back.
export const PLACEHOLDER = '.pre-style';

// Where a block's root came from, kept in its raws.
interface BlockInfo {
  lang: Lang;
  // The block's content offsets in the file.
  start: number;
  end: number;
  // Each `${…}`'s placeholder, and the text it replaced.
  expressions: [placeholder: string, text: string][];
}

type RootRaws = Root['raws'] & { preStyle?: BlockInfo; preStyleLang?: Lang };

const LANGS: Record<Lang, Syntax> = { css: postcss, scss: postcssScss };

// Everything but line breaks, as spaces, so a block parsed from a copy of
// the file has the file's offsets, lines, and columns.
const blank = (code: string) => code.replace(/[^\r\n]/g, ' ');

// A `${…}`'s placeholder: `$`, an id, and underscores, as long as the text
// it replaces and with its line breaks, so offsets hold. Value rules skip a
// value starting with `$`, as for a Sass variable. The id is `index` in
// letters (`a`, `b`, …, `ba`), since a digit would start a number (`$3__` is
// `$` and a `3__` dimension, an unknown unit). It's written around line
// breaks, so a multi-line `${…}` keeps all of it: the shortest `${…}` has 4
// other characters, room for 17,576 ids.
export function placeholder(text: string, index: number): string {
  const id = [...index.toString(26)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 26)))
    .join('');
  const fill = `$${id}`;
  let out = '';
  let used = 0;
  for (const char of text) out += char === '\n' || char === '\r' ? char : (fill[used++] ?? '_');
  return out;
}

function parseFile(css: string | { toString(): string }, opts: ProcessOptions = {}) {
  const code = css.toString();
  const file = opts.from ?? '';
  const kind = fileKind(file);

  // Stylesheet files, and files of unknown kinds, are parsed as stylesheets.
  if (kind === null || kind === 'css' || kind === 'scss') {
    const lang = kind === 'scss' ? 'scss' : 'css';
    const root = LANGS[lang].parse!(code, opts) as Root;
    (root.raws as RootRaws).preStyleLang = lang;
    return root;
  }

  const document = new Document();
  document.source = {
    input: new Input(code, opts),
    start: { offset: 0, line: 1, column: 1 },
  };
  const { blocks } = findBlocks(file, code, kind);
  if (blocks.length === 0) return document;

  const blanked = blank(code);
  for (const { lang, start, end, expressions } of blocks) {
    // The content, with each `${…}` replaced by its placeholder. Ids that
    // already appear in the block are skipped, so each placeholder is
    // unique and writing back is a plain replacement.
    const replaced: BlockInfo['expressions'] = [];
    const original = code.slice(start, end);
    let content = '';
    let at = start;
    let index = 0;
    for (const expression of expressions) {
      const text = code.slice(expression.start, expression.end);
      let replacement = placeholder(text, index++);
      while (original.includes(replacement) || replaced.some(([used]) => used === replacement))
        replacement = placeholder(text, index++);
      content += code.slice(at, expression.start) + replacement;
      replaced.push([replacement, text]);
      at = expression.end;
    }
    content += code.slice(at, end);
    // With a `{` on its opening backtick and a `}` on its closing one: a
    // rule with no selector, whose body is the block.
    const text = `${blanked.slice(0, start - 1)}{${content}}${blanked.slice(end + 1)}`;
    const root = LANGS[lang].parse!(text, { ...opts, document: code } as ProcessOptions) as Root;
    const wrapper = root.first as Rule;
    wrapper.selector = PLACEHOLDER;
    (root.raws as RootRaws).preStyle = { lang, start, end, expressions: replaced };
    root.parent = document;
    document.nodes.push(root);
  }
  return document;
}

const info = (root: Root) => (root.raws as RootRaws).preStyle;

// Puts each `${…}` back in place of its placeholder.
function restore(part: string, { expressions }: BlockInfo): string {
  let out = part;
  for (const [replacement, text] of expressions)
    if (out.includes(replacement)) out = out.replaceAll(replacement, () => text);
  return out;
}

// Writes a block's content: its wrapper rule without the selector and
// braces, which aren't in the file, and with its `${…}` restored.
function writeBlock(root: Root, block: BlockInfo, builder: Builder) {
  const wrapper = root.first;
  if (wrapper === undefined) return;
  LANGS[block.lang].stringify!(wrapper, (part, node, type) => {
    if (node === wrapper && (type === 'start' || type === 'end')) return;
    builder(restore(part, block), node, type);
  });
}

function stringify(node: AnyNode | Document, builder: Builder): void {
  if (node.type === 'document') {
    const code = node.source?.input.css ?? '';
    let at = 0;
    for (const root of node.nodes) {
      const block = info(root);
      if (block === undefined) continue;
      builder(code.slice(at, block.start));
      writeBlock(root, block, builder);
      at = block.end;
    }
    builder(code.slice(at));
    return;
  }
  const root = node.type === 'root' ? node : node.root();
  const block = root.type === 'root' ? info(root) : undefined;
  if (block !== undefined) {
    if (node === root || node === root.first) writeBlock(root, block, builder);
    else
      LANGS[block.lang].stringify!(node, (part, ...rest) => builder(restore(part, block), ...rest));
    return;
  }
  const lang = root.type === 'root' ? (root.raws as RootRaws).preStyleLang : undefined;
  LANGS[lang ?? 'css'].stringify!(node, builder);
}

// Stylelint's `customSyntax`: each block in a JS, TS, Astro, or HTML file is
// a root of a PostCSS document, and `.css` and `.scss` files are stylesheets.
const syntax: Syntax<Root | Document> = { parse: parseFile, stringify };

export default syntax;
export { parseFile as parse, stringify };
