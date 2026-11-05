import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { completeInBlock } from '../src/complete.ts';

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
