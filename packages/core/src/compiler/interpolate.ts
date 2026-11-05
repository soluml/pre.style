import { PreStyleError } from './block.ts';
import type { Lang, Position } from './block.ts';

// An interpolation's text: `${w}px` is `strings: ['', 'px']` and
// `expressions: [0]`, where each expression is an index into the block's.
export interface Slot {
  strings: string[];
  expressions: number[];
}

export interface Interpolated {
  // The block with a placeholder variable in place of each slot.
  code: string;
  slots: Slot[];
}

// Each slot is written as this variable, plus its index, until the block is
// parsed. See `variables.ts`.
export const SLOT_PREFIX = '--__pre-style-slot-';

// Stands for an expression while scanning, since it can't be in CSS.
const EXPRESSION = '\0';

// Ends a token, so `${w}px` is one slot, and `${a} ${b}` is two.
const DELIMITER = /[\s,()/;:{}!"']/;
const IDENT = /[\w-]/;

// At-rules that can't read a runtime value: their descriptors don't accept
// `var()`, or, for `@page`, have no element to read it from. Others, such as
// `@keyframes`, `@position-try`, and `@function`, read it from the element
// that uses them.
const NO_VARIABLES =
  /^@(font-face|property|page|counter-style|font-feature-values|font-palette-values|view-transition)\b/i;

// Sass at-rules whose arguments are evaluated, rather than written out.
const SASS_AT_RULES = /^@(include|return|if|else|each|for|while|debug|warn|error|function|mixin)\b/;

const POSITION_MESSAGE =
  "`${…}` can only be used in a declaration's value, because it becomes a `var()`, which isn't valid in selectors, property names, or at-rule conditions. To share media queries, use Sass variables.";
const NO_VARIABLES_MESSAGE =
  "`${…}` can't be used here: this at-rule doesn't accept `var()`, or has no element for the runtime to set it on.";
const QUOTED_MESSAGE =
  '`${…}` can\'t be used inside a quoted string or `url()`, because it becomes a `var()`, which doesn\'t work there. Pass the whole value instead: `content: ${JSON.stringify(label)}`, or `--image: ${`url("${path}")`}` with `background-image: var(--image)`.';
const FUNCTION_MESSAGE = "`${…}` can't be used as a function's name.";

const newlines = (text: string) => text.split('\n').length - 1;

// Replaces each `${…}` in a block with a placeholder variable. `strings` are
// the text around the expressions, and `expressions` their source, which is
// only used for positions, so errors and lines match the file.
export function interpolate(strings: string[], expressions: string[], lang: Lang): Interpolated {
  const text = strings.join(EXPRESSION);
  const slots: Slot[] = [];

  // The position of the expression at an offset in `text`.
  const positionAt = (offset: number): Position => {
    let written = '';
    let index = 0;
    for (let i = 0; i < offset; i++) {
      if (text[i] === EXPRESSION) written += `\${${expressions[index++]}}`;
      else written += text[i];
    }
    const lastLine = written.lastIndexOf('\n');
    return { line: newlines(written), column: written.length - lastLine };
  };
  const fail = (message: string, offset: number): never => {
    throw new PreStyleError(message, positionAt(offset));
  };
  // How many expressions come before an offset.
  const expressionIndex = (offset: number) => text.slice(0, offset).split(EXPRESSION).length - 1;

  // Adds a slot for the text at [start, end), and returns its placeholder's
  // name, and the newlines to write after it, so later lines stay in place.
  const addSlot = (start: number, end: number) => {
    const first = expressionIndex(start);
    const parts = text.slice(start, end).split(EXPRESSION);
    const used = Array.from({ length: parts.length - 1 }, (_, i) => first + i);
    const index = slots.push({ strings: parts, expressions: used }) - 1;
    const lines =
      newlines(text.slice(start, end)) + used.reduce((n, e) => n + newlines(expressions[e]), 0);
    return { name: `${SLOT_PREFIX}${index}`, lines: '\n'.repeat(lines) };
  };

  // What's open: parentheses and Sass's `#{…}`, which don't end statements,
  // and blocks, with the text before each.
  const open: { type: '(' | '#{' | '{'; header: string }[] = [];
  const atStatementLevel = () => open.length === 0 || open.at(-1)!.type === '{';
  let statementStart = 0;

  // The end of the string starting at `start`, an error if it has an
  // expression in it.
  const stringEnd = (start: number) => {
    let i = start + 1;
    for (; i < text.length && text[i] !== text[start]; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === EXPRESSION) fail(QUOTED_MESSAGE, i);
    }
    return i + 1;
  };

  // What ends the statement at `start`: `;`, `{`, `}`, or nothing.
  const statementEnd = (start: number) => {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' || ch === "'") i = stringEnd(i) - 1;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '#' && text[i + 1] === '{') {
        depth++;
        i++;
      } else if (ch === '}' && depth > 0) depth--;
      else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) return ch;
    }
    return '';
  };

  // Checks that a slot starting at `start` and ending at `end` is in a
  // declaration's value.
  const checkPosition = (start: number, end: number) => {
    const offset = text.indexOf(EXPRESSION, start);
    for (const { type, header } of open)
      if (type === '{' && NO_VARIABLES.test(header.trim())) fail(NO_VARIABLES_MESSAGE, offset);
    const statement = text.slice(statementStart, start).trimStart();
    if (statement.startsWith('@')) {
      if (lang !== 'scss' || !SASS_AT_RULES.test(statement)) fail(POSITION_MESSAGE, offset);
      return;
    }
    if (!statement.includes(':') || statementEnd(end) === '{') fail(POSITION_MESSAGE, offset);
  };

  // The end of `var()`'s first argument, starting at `start`.
  const firstArgumentEnd = (start: number) => {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' || ch === "'") i = stringEnd(i) - 1;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) return i;
        depth--;
      } else if (ch === ',' && depth === 0) return i;
    }
    return text.length;
  };

  let code = '';
  // Where the current token starts, in `text` and in `code`.
  let tokenStart = 0;
  let tokenCode = 0;
  // Keeps a comment's text, without its expressions, and the lines they took.
  const comment = (start: number, end: number) => {
    const first = expressionIndex(start);
    const parts = text.slice(start, end).split(EXPRESSION);
    let lines = '';
    for (let i = 0; i < parts.length - 1; i++)
      lines += '\n'.repeat(newlines(expressions[first + i]));
    return parts.join('') + lines;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      code += comment(i, end);
      i = end;
      tokenStart = i;
      tokenCode = code.length;
      continue;
    }
    if (lang === 'scss' && ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      code += comment(i, end);
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = stringEnd(i);
      code += text.slice(i, end);
      i = end;
      tokenStart = i;
      tokenCode = code.length;
      continue;
    }

    const standsAlone = i === 0 || !IDENT.test(text[i - 1]);

    // An unquoted `url()` is one token, which can't hold a `var()`.
    if (standsAlone && text.slice(i, i + 4).toLowerCase() === 'url(') {
      const argument = /\s*/y;
      argument.lastIndex = i + 4;
      const first = text[i + 4 + argument.exec(text)![0].length];
      if (first !== '"' && first !== "'") {
        const close = text.indexOf(')', i);
        const end = close === -1 ? text.length : close + 1;
        const inside = text.indexOf(EXPRESSION, i);
        if (inside !== -1 && inside < end) fail(QUOTED_MESSAGE, inside);
        code += text.slice(i, end);
        i = end;
        tokenStart = i;
        tokenCode = code.length;
        continue;
      }
    }

    // `var(${w}px, 120px)`: the first argument is one slot, and what follows
    // is an ordinary fallback.
    if (standsAlone && text.slice(i, i + 4).toLowerCase() === 'var(') {
      const end = firstArgumentEnd(i + 4);
      const raw = text.slice(i + 4, end);
      if (raw.includes(EXPRESSION)) {
        const start = i + 4 + (raw.length - raw.trimStart().length);
        const trimmedEnd = i + 4 + raw.trimEnd().length;
        checkPosition(start, end);
        const slot = addSlot(start, trimmedEnd);
        code += `var(${slot.name}${slot.lines}`;
        open.push({ type: '(', header: '' });
        i = end;
        tokenStart = i;
        tokenCode = code.length;
        continue;
      }
    }

    if (ch === EXPRESSION) {
      let end = i;
      while (end < text.length && !DELIMITER.test(text[end])) end++;
      if (text[end] === '(') fail(FUNCTION_MESSAGE, i);
      checkPosition(tokenStart, end);
      const slot = addSlot(tokenStart, end);
      code = `${code.slice(0, tokenCode)}var(${slot.name})${slot.lines}`;
      i = end;
      tokenStart = i;
      tokenCode = code.length;
      continue;
    }

    if (ch === '#' && text[i + 1] === '{') {
      open.push({ type: '#{', header: '' });
      code += '#{';
      i += 2;
      continue;
    }

    if (ch === '(') open.push({ type: '(', header: '' });
    else if (ch === ')') {
      if (open.at(-1)?.type === '(') open.pop();
    } else if (ch === '{') {
      if (atStatementLevel()) {
        open.push({ type: '{', header: text.slice(statementStart, i) });
        statementStart = i + 1;
      }
    } else if (ch === '}') {
      if (open.length > 0) open.pop();
      if (atStatementLevel()) statementStart = i + 1;
    } else if (ch === ';' && atStatementLevel()) statementStart = i + 1;

    code += ch;
    i++;
    if (DELIMITER.test(ch)) {
      tokenStart = i;
      tokenCode = code.length;
    }
  }

  return { code, slots };
}
