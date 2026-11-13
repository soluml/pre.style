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
}

type RootRaws = Root['raws'] & { preStyle?: BlockInfo; preStyleLang?: Lang };

const LANGS: Record<Lang, Syntax> = { css: postcss, scss: postcssScss };

// Everything but line breaks, as spaces, so a block parsed from a copy of
// the file has the file's offsets, lines, and columns.
const blank = (code: string) => code.replace(/[^\r\n]/g, ' ');

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
  for (const { lang, start, end } of blocks) {
    // The content, with a `{` on its opening backtick and a `}` on its
    // closing one: a rule with no selector, whose body is the block.
    const text = `${blanked.slice(0, start - 1)}{${code.slice(start, end)}}${blanked.slice(end + 1)}`;
    const root = LANGS[lang].parse!(text, { ...opts, document: code } as ProcessOptions) as Root;
    const wrapper = root.first as Rule;
    wrapper.selector = PLACEHOLDER;
    (root.raws as RootRaws).preStyle = { lang, start, end };
    root.parent = document;
    document.nodes.push(root);
  }
  return document;
}

const info = (root: Root) => (root.raws as RootRaws).preStyle;

// Writes a block's content: its wrapper rule without the selector and
// braces, which aren't in the file.
function writeBlock(root: Root, lang: Lang, builder: Builder) {
  const wrapper = root.first;
  if (wrapper === undefined) return;
  LANGS[lang].stringify!(wrapper, (part, node, type) => {
    if (node === wrapper && (type === 'start' || type === 'end')) return;
    builder(part, node, type);
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
      writeBlock(root, block.lang, builder);
      at = block.end;
    }
    builder(code.slice(at));
    return;
  }
  const root = node.type === 'root' ? node : node.root();
  const block = root.type === 'root' ? info(root) : undefined;
  if (block !== undefined && (node === root || node === root.first)) {
    writeBlock(root, block.lang, builder);
    return;
  }
  const lang =
    block?.lang ?? (root.type === 'root' ? (root.raws as RootRaws).preStyleLang : undefined);
  LANGS[lang ?? 'css'].stringify!(node, builder);
}

// Stylelint's `customSyntax`: each block in a JS, TS, Astro, or HTML file is
// a root of a PostCSS document, and `.css` and `.scss` files are stylesheets.
const syntax: Syntax<Root | Document> = { parse: parseFile, stringify };

export default syntax;
export { parseFile as parse, stringify };
