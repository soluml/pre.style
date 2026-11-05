import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blockStylesheet, findBlockAt } from '../src/blocks.ts';

// `|` marks the offset, and is removed from the text.
function at(source: string, html = false) {
  const offset = source.indexOf('|');
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { text, offset, block: findBlockAt(text, offset, html) };
}

describe('findBlockAt', () => {
  test('finds the block around the offset', () => {
    const { text, block } = at('const a = css`color: |red`;');
    assert.ok(block);
    assert.equal(block.language, 'css');
    assert.equal(text.slice(block.contentStart, block.contentEnd), 'color: red');
  });

  test('includes both ends of the content', () => {
    assert.ok(at('css`|color`').block);
    assert.ok(at('css`color|`').block);
    assert.equal(at('css|`color`').block, undefined);
    assert.equal(at('css`color`|').block, undefined);
  });

  test('scss blocks and a space before the backtick', () => {
    assert.equal(at('scss `$a: |1px`').block?.language, 'scss');
  });

  test('skips earlier blocks and other template literals', () => {
    assert.equal(at('css`a: b`; x`c|`; scss`d: e`').block, undefined);
    const { text, block } = at('css`a: b`; x`c`; scss`d: |e`');
    assert.equal(text.slice(block!.contentStart, block!.contentEnd), 'd: e');
  });

  test('an unclosed block runs to the end', () => {
    const { text, block } = at('css`\n  color: |');
    assert.equal(block?.contentEnd, text.length);
  });

  test('escaped backticks do not close a block', () => {
    assert.ok(at('css`content: "\\`"; |`').block);
  });

  test('only bare tags', () => {
    assert.equal(at('a.css`|`').block, undefined);
    assert.equal(at('mycss`|`').block, undefined);
    assert.equal(at('$css`|`').block, undefined);
  });

  test('a tag after a quote is a block in HTML only', () => {
    assert.equal(at('<div class="css`|`">').block, undefined);
    assert.ok(at('<div class="css`|`">', true).block);
  });
});

describe('blocks with `${…}`', () => {
  test('a backtick in an expression does not close the block', () => {
    assert.ok(at('css`width: ${`${a}px`}; col|`').block);
    assert.ok(at('css`width: ${f(`a`)}; col|`').block);
  });

  test('braces, strings, and comments in an expression', () => {
    assert.ok(at('css`width: ${{ a: 1 }.a}; col|`').block);
    assert.ok(at("css`width: ${'}`'}; col|`").block);
    assert.ok(at('css`width: ${a /* } */}; col|`').block);
    assert.ok(at('css`width: ${a // }\n}; col|`').block);
  });

  test('records each expression', () => {
    const { text, block } = at('css`a: ${b}c ${d}; |`');
    assert.deepEqual(
      block!.expressions.map(([start, end]) => text.slice(start, end)),
      ['${b}', '${d}'],
    );
  });

  test('a later block is still found', () => {
    assert.ok(at('css`a: ${`b`};`; const x = 1; scss`|`').block);
    assert.equal(at('css`a: ${`b`};`; const |x = 1;').block, undefined);
  });

  test('an unclosed expression runs to the end', () => {
    assert.equal(at('css`a: ${b|').block?.contentEnd, 'css`a: ${b'.length);
  });
});

describe('blockStylesheet', () => {
  test('keeps offsets and line breaks, and wraps the block in a rule', () => {
    const { text, block } = at('const a = 1;\nconst b = css`\n  color: |red;\n`;\nfoo();');
    const sheet = blockStylesheet(text, block!);
    assert.equal(sheet.length, text.length);
    assert.equal(sheet, '            \n          x  {\n  color: red;\n} \n      ');
  });

  test('an unclosed block has no closing brace', () => {
    const { text, block } = at('scss`$a: |');
    assert.equal(blockStylesheet(text, block!), 'x   {$a: ');
  });

  test('expressions become an identifier, keeping offsets and line breaks', () => {
    const { text, block } = at('css`width: ${w +\n1}px;|`');
    const sheet = blockStylesheet(text, block!);
    assert.equal(sheet.length, text.length);
    assert.equal(sheet, 'x  {width: _____\n__px;}');
  });
});
