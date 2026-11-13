import { extname } from 'node:path';
import {
  FindError,
  findInComponent,
  findInHtml,
  findInScript,
  type FoundBlock,
} from '@pre.style/core/find';
import type { Lang } from '@pre.style/core/compiler';

const SCRIPTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

// How a file is linted: blocks found in a source file, or the whole file as
// a stylesheet.
export type FileKind = 'script' | 'component' | 'html' | Lang;

export function fileKind(file: string): FileKind | null {
  const ext = extname(file).toLowerCase();
  if (SCRIPTS.has(ext)) return 'script';
  if (ext === '.astro') return 'component';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.scss') return 'scss';
  return null;
}

// A block's content, between its backticks.
export interface LintBlock {
  lang: Lang;
  // The content's offsets in the file.
  start: number;
  end: number;
  // Each `${…}`, from `$` to `}`, as offsets in the file.
  expressions: { start: number; end: number }[];
  found: FoundBlock;
}

// The offset of the `}` that closes an expression ending at `from`, after
// whitespace and comments.
function closingBrace(code: string, from: number): number {
  let i = from;
  while (i < code.length && code[i] !== '}') {
    if (code.startsWith('/*', i)) i = code.indexOf('*/', i + 2) + 2;
    else if (code.startsWith('//', i)) i = code.indexOf('\n', i);
    else i++;
    if (i <= 0) return code.length;
  }
  return i;
}

// Where each `${…}` of a block is: the text before each one is known, and
// each ends at the `}` after its expression.
function expressionSpans(code: string, start: number, block: FoundBlock) {
  const spans: LintBlock['expressions'] = [];
  const { strings, expressions } = block.interpolation ?? { strings: [], expressions: [] };
  let at = start;
  expressions.forEach((expression, i) => {
    at += strings[i].length;
    const end = closingBrace(code, expression.end) + 1;
    spans.push({ start: at, end });
    at = end;
  });
  return spans;
}

// Finds a source file's blocks the way the build does: imports decide
// what's a block in scripts, and text matching finds them in Astro
// components and HTML. Misused blocks are returned as errors rather than
// thrown, so the rest of the file is still linted.
export function findBlocks(
  file: string,
  code: string,
  kind: 'script' | 'component' | 'html',
): { blocks: LintBlock[]; errors: FindError[] } {
  const errors: FindError[] = [];
  let found: FoundBlock[] = [];
  if (kind === 'script') {
    if (code.includes('@pre.style/core')) {
      try {
        found = findInScript(file, code, errors)?.blocks ?? [];
      } catch (error) {
        // Only a syntax error the parser can't recover from gets here.
        if (!(error instanceof FindError)) throw error;
        errors.push(error);
      }
    }
  } else if (kind === 'component') {
    if (code.includes('@pre.style/core')) found = findInComponent(code);
  } else if (code.includes('css`')) found = findInHtml(code);

  const blocks: LintBlock[] = [];
  let last = 0;
  for (const block of found.toSorted((a, b) => a.start - b.start)) {
    // A block inside another's `${…}` is an error the finder reports.
    if (block.start < last) continue;
    const end = block.end - 1;
    const start = end - block.code.length;
    const expressions = expressionSpans(code, start, block);
    blocks.push({ lang: block.lang, start, end, expressions, found: block });
    last = block.end;
  }
  return { blocks, errors };
}
