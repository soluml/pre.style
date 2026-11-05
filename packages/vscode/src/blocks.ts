export type BlockLanguage = 'css' | 'scss';

export interface Block {
  language: BlockLanguage;
  /** Offset of the tag (`css` or `scss`). */
  start: number;
  /** Offset just after the opening backtick. */
  contentStart: number;
  /** Offset of the closing backtick, or the end of the text if it's unclosed. */
  contentEnd: number;
  /** Where each `${…}` starts and ends, including its `${` and `}`. */
  expressions: [start: number, end: number][];
}

// A bare tag, as in the grammar. In code, a tag right after a quote is in a
// string; in HTML that's where blocks are (`class="css`…`"`).
const CODE_TAG = /(?<![\w$.`'"])(s?css)\s*`/g;
const HTML_TAG = /(?<![\w$.`])(s?css)\s*`/g;

// The offset after the `}` that ends the `${` before `from`, skipping strings,
// comments, and nested templates and braces, or the end of the text.
function expressionEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return i + 1;
      depth--;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== '\n'; i++)
        if (text[i] === '\\') i++;
    } else if (ch === '`') {
      const close = closingBacktick(text, i + 1, []);
      if (close === -1) return text.length;
      i = close;
    } else if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) return text.length;
      i = newline;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return text.length;
      i = close + 1;
    }
  }
  return text.length;
}

// The backtick that ends a template starting at `from`, or -1. Its `${…}` are
// added to `expressions`, since they can hold backticks of their own.
function closingBacktick(text: string, from: number, expressions: Block['expressions']): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') return i;
    else if (text[i] === '$' && text[i + 1] === '{') {
      const end = expressionEnd(text, i + 2);
      expressions.push([i, end]);
      i = end - 1;
    }
  }
  return -1;
}

/** The block whose content contains `offset` (inclusive at both ends). */
export function findBlockAt(text: string, offset: number, html = false): Block | undefined {
  const tag = new RegExp(html ? HTML_TAG : CODE_TAG);
  for (let m = tag.exec(text); m && m.index < offset; m = tag.exec(text)) {
    const contentStart = m.index + m[0].length;
    const expressions: Block['expressions'] = [];
    const close = closingBacktick(text, contentStart, expressions);
    const contentEnd = close === -1 ? text.length : close;
    if (offset >= contentStart && offset <= contentEnd) {
      return {
        language: m[1] as BlockLanguage,
        start: m.index,
        contentStart,
        contentEnd,
        expressions,
      };
    }
    if (close === -1) return undefined;
    tag.lastIndex = close + 1;
  }
  return undefined;
}

const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');

// The block's content, with each `${…}` as an identifier, so `${w}px` stays one
// value to the CSS parser.
function contentOf(text: string, block: Block): string {
  let content = '';
  let at = block.contentStart;
  for (const [start, end] of block.expressions) {
    content += text.slice(at, start) + text.slice(start, end).replace(/[^\r\n]/g, '_');
    at = end;
  }
  return content + text.slice(at, block.contentEnd);
}

/**
 * A stylesheet with the same offsets and line breaks as `text`, holding only
 * the block as a rule: the tag becomes a selector and an opening brace, the
 * closing backtick a closing brace, and everything else spaces.
 */
export function blockStylesheet(text: string, block: Block): string {
  const tag = blank(text.slice(block.start, block.contentStart));
  const closed = block.contentEnd < text.length;
  return (
    blank(text.slice(0, block.start)) +
    'x' +
    tag.slice(1, -1) +
    '{' +
    contentOf(text, block) +
    (closed ? '}' + blank(text.slice(block.contentEnd + 1)) : '')
  );
}
