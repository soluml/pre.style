import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { completeInBlock, defineInBlock, type PrependedFile } from '../src/complete.ts';

// `|` marks the cursor, and is removed from the text.
function complete(source: string, html = false) {
  const offset = source.indexOf('|');
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return completeInBlock(text, offset, html);
}

function labels(source: string, html = false): string[] {
  return complete(source, html)?.list.items.map((i) => i.label) ?? [];
}

describe('completeInBlock', () => {
  test('property names at the top level of a block', () => {
    const items = labels('const a = css`\n  back|\n`;');
    assert.ok(items.includes('background-color'));
  });

  test('property values', () => {
    const items = labels('const a = css`display: |`;');
    assert.ok(items.includes('flex'));
    assert.ok(items.includes('grid'));
  });

  test('pseudo-classes after &', () => {
    assert.ok(labels('css`\n  &:|\n`').includes(':hover'));
  });

  test('inside nested rules and at-rules', () => {
    assert.ok(labels('css`&:hover { col| }`').includes('color'));
    assert.ok(labels('css`@media (min-width: 768px) { col| }`').includes('color'));
  });

  test('Sass variables in scss blocks', () => {
    const result = complete('scss`\n  $size: 2rem;\n  font-size: |\n`');
    assert.equal(result?.language, 'scss');
    assert.ok(result?.list.items.some((i) => i.label === '$size'));
  });

  test('ranges are positions in the original text', () => {
    const result = complete('const a = 1;\nconst b = css`\n  back|\n`;');
    const edit = result?.list.items.find((i) => i.label === 'background-color')?.textEdit;
    assert.ok(edit && 'range' in edit);
    assert.deepEqual(edit.range, {
      start: { line: 2, character: 2 },
      end: { line: 2, character: 6 },
    });
  });

  test('blocks in HTML attributes', () => {
    assert.ok(labels('<div class="css`col|`"></div>', true).includes('color'));
  });

  test('nothing outside blocks', () => {
    assert.equal(complete('const a = |1;'), undefined);
    assert.equal(complete('css`color: red`; const a = |1;'), undefined);
  });

  test('after a `${…}`, in the same block', () => {
    assert.ok(labels('css`width: ${w}px; col|`').includes('color'));
    assert.ok(labels('css`width: ${`${w}px`}; col|`').includes('color'));
    assert.ok(labels('css`&::before { content: ${c}; col| }`').includes('color'));
  });

  test('values next to a `${…}`', () => {
    assert.ok(labels('css`margin: ${m}px; display: |`').includes('flex'));
  });

  test('nothing inside a `${…}`', () => {
    assert.equal(complete('css`width: ${wi|dth}px;`'), undefined);
    assert.equal(complete('css`width: ${|}px;`'), undefined);
  });

  test('scss blocks with `${…}`', () => {
    assert.ok(labels('scss`$size: 1px; width: ${w}px; height: |`').includes('$size'));
  });
});

const mixins: PrependedFile = {
  uri: 'file:///app/src/_mixins.scss',
  text: [
    "@use 'sass:math';",
    '$gap: 4px;',
    '',
    '@mixin layout-grid($columns: 2) {',
    '  display: grid;',
    '}',
    '',
    '@function rem($px) {',
    '  @return math.div($px, 16) * 1rem;',
    '}',
    '',
    '%card {',
    '  padding: $gap;',
    '}',
  ].join('\n'),
};
const tokens: PrependedFile = {
  uri: 'file:///app/src/tokens.css',
  text: ':root {\r\n  --brand: red;\r\n}\r\n',
};

function withPrepended(source: string, files: PrependedFile[], html = false) {
  const offset = source.indexOf('|');
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return completeInBlock(text, offset, html, undefined, files);
}

const prependedLabels = (source: string, files: PrependedFile[]) =>
  withPrepended(source, files)?.list.items.map((i) => i.label) ?? [];

describe('completeInBlock with prepended files', () => {
  test('mixins after @include', () => {
    assert.deepEqual(prependedLabels('scss`\n  @include |\n`', [mixins]), ['layout-grid']);
    assert.ok(prependedLabels('scss`@include lay|;`', [mixins]).includes('layout-grid'));
  });

  test('variables and functions in values', () => {
    const items = prependedLabels('scss`width: $|`', [mixins]);
    assert.ok(items.includes('$gap'));
    assert.ok(items.includes('rem'));
  });

  test('placeholders after @extend', () => {
    assert.ok(prependedLabels('scss`@extend %|`', [mixins]).includes('%card'));
  });

  test('custom properties in var()', () => {
    assert.ok(prependedLabels('css`color: var(--|)`', [tokens]).includes('--brand'));
  });

  test('ranges stay in the original text', () => {
    const result = withPrepended('const a = 1;\nconst b = scss`\n  @include lay|\n`;', [mixins]);
    const edit = result?.list.items.find((i) => i.label === 'layout-grid')?.textEdit;
    assert.ok(edit && 'range' in edit);
    assert.deepEqual(edit.range, {
      start: { line: 2, character: 11 },
      end: { line: 2, character: 14 },
    });
  });
});

function define(source: string, files: PrependedFile[] = []) {
  const offset = source.indexOf('|');
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return defineInBlock(text, offset, false, files);
}

describe('defineInBlock', () => {
  test('a mixin in a prepended file', () => {
    const result = define('const a = 1;\nscss`\n  @include layout-g|rid;\n`', [mixins]);
    assert.equal(result?.uri, mixins.uri);
    assert.deepEqual(result?.range.start, { line: 3, character: 0 });
  });

  test('variables and functions in a prepended file', () => {
    assert.deepEqual(define('scss`gap: $g|ap;`', [mixins])?.range.start, {
      line: 1,
      character: 0,
    });
    assert.deepEqual(define('scss`width: re|m(3px);`', [mixins])?.range.start, {
      line: 7,
      character: 0,
    });
  });

  test('the right file, when there are several', () => {
    const result = define('scss`@include layout-g|rid;`', [tokens, mixins]);
    assert.equal(result?.uri, mixins.uri);
    assert.deepEqual(result?.range.start, { line: 3, character: 0 });
  });

  test('a definition in the block itself', () => {
    const result = define('const a = 1;\nscss`\n  $w: 1px;\n  width: $|w;\n`', [mixins]);
    assert.equal(result?.uri, undefined);
    assert.deepEqual(result?.range.start, { line: 2, character: 2 });
  });

  test('nothing for unknown names or outside blocks', () => {
    assert.equal(define('scss`@include nope|;`', [mixins]), undefined);
    assert.equal(define('const a = |1;', [mixins]), undefined);
  });
});
