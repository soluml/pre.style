import {
  getCSSLanguageService,
  getSCSSLanguageService,
  type CompletionList,
  type CompletionSettings,
  type LanguageService,
  type LanguageServiceOptions,
  type Range,
  type Stylesheet,
} from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { blockStylesheet, findBlockAt, type BlockLanguage } from './blocks.ts';

const options: LanguageServiceOptions = {
  clientCapabilities: {
    textDocument: {
      completion: {
        completionItem: { documentationFormat: ['markdown', 'plaintext'] },
      },
    },
  },
};

// Created on first use: loading the CSS data takes a moment.
const services: Partial<Record<BlockLanguage, LanguageService>> = {};

function service(language: BlockLanguage): LanguageService {
  return (services[language] ??=
    language === 'css' ? getCSSLanguageService(options) : getSCSSLanguageService(options));
}

/** A file prepended to the block's language, as the build prepends it. */
export interface PrependedFile {
  uri: string;
  text: string;
}

interface Prepared {
  language: BlockLanguage;
  ls: LanguageService;
  doc: TextDocument;
  stylesheet: Stylesheet;
  /** Lines before the block's text: the prepended files. */
  shift: number;
  /** Characters before the block's text. */
  prefix: number;
  /** Where each prepended file starts in the virtual document. */
  files: { uri: string; line: number; lines: number }[];
}

// The prepended files' code goes above the block's stylesheet, so their mixins,
// functions, variables, placeholders, and custom properties are in scope. Each
// file starts on a new line, so the block's positions move down by whole lines.
function prepare(
  text: string,
  offset: number,
  html: boolean,
  prepended: readonly PrependedFile[],
): Prepared | undefined {
  const block = findBlockAt(text, offset, html);
  if (!block) return undefined;
  // Inside `${…}` is JavaScript, which VS Code's own language service handles.
  if (block.expressions.some(([start, end]) => offset > start && offset < end)) return undefined;
  const files: Prepared['files'] = [];
  let prefix = '';
  let shift = 0;
  for (const file of prepended) {
    const lines = file.text.split('\n').length;
    files.push({ uri: file.uri, line: shift, lines });
    prefix += file.text + '\n';
    shift += lines;
  }
  const doc = TextDocument.create(
    'pre-style://block',
    block.language,
    0,
    prefix + blockStylesheet(text, block),
  );
  const ls = service(block.language);
  return {
    language: block.language,
    ls,
    doc,
    stylesheet: ls.parseStylesheet(doc),
    shift,
    prefix: prefix.length,
    files,
  };
}

const moveRange = (r: Range, lines: number): Range => ({
  start: { line: r.start.line - lines, character: r.start.character },
  end: { line: r.end.line - lines, character: r.end.character },
});

// An offset in `text` as a position in the virtual document.
const toVirtual = (p: Prepared, offset: number) => p.doc.positionAt(p.prefix + offset);

export interface BlockCompletions {
  language: BlockLanguage;
  list: CompletionList;
}

/** Completions at `offset` if it's inside a block, with ranges in `text`'s positions. */
export function completeInBlock(
  text: string,
  offset: number,
  html: boolean,
  settings?: (language: BlockLanguage) => CompletionSettings | undefined,
  prepended: readonly PrependedFile[] = [],
): BlockCompletions | undefined {
  const p = prepare(text, offset, html, prepended);
  if (!p) return undefined;
  const list = p.ls.doComplete(p.doc, toVirtual(p, offset), p.stylesheet, settings?.(p.language));
  if (p.shift) {
    for (const item of list.items) {
      const edit = item.textEdit;
      if (!edit) continue;
      if ('range' in edit) edit.range = moveRange(edit.range, p.shift);
      else {
        edit.insert = moveRange(edit.insert, p.shift);
        edit.replace = moveRange(edit.replace, p.shift);
      }
    }
  }
  return { language: p.language, list };
}

export interface BlockDefinition {
  /** The prepended file it's in, or undefined for `text` itself. */
  uri?: string;
  range: Range;
}

/**
 * Where the mixin, function, variable, placeholder, or custom property at
 * `offset` is defined: in the block, or in a prepended file.
 */
export function defineInBlock(
  text: string,
  offset: number,
  html: boolean,
  prepended: readonly PrependedFile[] = [],
): BlockDefinition | undefined {
  const p = prepare(text, offset, html, prepended);
  if (!p) return undefined;
  const location = p.ls.findDefinition(p.doc, toVirtual(p, offset), p.stylesheet);
  if (!location) return undefined;
  const { line } = location.range.start;
  if (line >= p.shift) return { range: moveRange(location.range, p.shift) };
  const file = p.files.find((f) => line >= f.line && line < f.line + f.lines);
  return file && { uri: file.uri, range: moveRange(location.range, file.line) };
}
