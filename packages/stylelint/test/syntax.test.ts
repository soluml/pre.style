import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Declaration, Document, Root, Rule } from 'postcss';
import stylelint from 'stylelint';
import { parse as parseCode, PLACEHOLDER, stringify } from '../src/syntax.ts';

const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const parse = (name: string) => parseCode(read(name), { from: join(fixtures, name) });
const roots = (name: string) => (parse(name) as Document).nodes as Root[];
const write = (node: Parameters<typeof stringify>[0]) => {
  let out = '';
  stringify(node, (part) => (out += part));
  return out;
};

describe('round trip', () => {
  for (const name of readdirSync(fixtures))
    test(name, () => assert.equal(write(parse(name)), read(name)));
});

describe('finding blocks', () => {
  test('only blocks imported from @pre.style/core, including renamed imports', () => {
    const found = roots('button.tsx');
    assert.equal(found.length, 5);
    assert.deepEqual(
      found.map((root) => root.raws.preStyle.lang),
      ['css', 'scss', 'css', 'css', 'css'],
    );
  });

  test('Astro frontmatter, templates, and scripts', () => {
    assert.deepEqual(
      roots('card.astro').map((root) => write(root).trim()),
      ['color: blue;', 'margin: 0px;', 'padding: 1px;'],
    );
  });

  test('HTML attributes', () => {
    assert.deepEqual(
      roots('page.html').map((root) => write(root)),
      ['margin: 0px;', '$x: 1px; padding: $x;'],
    );
  });

  test('a misused tag still lints the file', () => {
    assert.equal(roots('misuse.ts').length, 1);
  });

  test('a file without blocks is an empty document', () => {
    assert.equal(roots('no-blocks.ts').length, 0);
  });

  test('stylesheet files are roots', () => {
    assert.equal(parse('sheet.css').type, 'root');
    assert.equal(parse('sheet.scss').type, 'root');
  });
});

describe('the wrapper rule', () => {
  test('has the placeholder selector, and the block as its body', () => {
    const [button] = roots('button.tsx');
    const wrapper = button.first as Rule;
    assert.equal(wrapper.type, 'rule');
    assert.equal(wrapper.selector, PLACEHOLDER);
    assert.deepEqual(
      wrapper.nodes.map((node) => node.type),
      ['decl', 'decl', 'comment', 'rule'],
    );
  });

  test('scss blocks are parsed as Sass', () => {
    const card = roots('button.tsx')[1].first as Rule;
    assert.deepEqual(
      card.nodes.map((node) => node.type),
      ['decl', 'comment', 'decl', 'atrule'],
    );
  });
});

describe('positions', () => {
  test('nodes have their positions in the file', () => {
    const [button] = roots('button.tsx');
    const color = (button.first as Rule).first as Declaration;
    assert.deepEqual(color.source!.start, { offset: 225, line: 10, column: 3 });
    assert.deepEqual(color.rangeBy({ word: '#FFFFFF' }).start, {
      offset: 232,
      line: 10,
      column: 10,
    });
  });

  test('CRLF line endings', () => {
    const [root] = roots('crlf.ts');
    assert.deepEqual(((root.first as Rule).first as Declaration).source!.start!.line, 3);
  });
});

const lint = async (name: string, rules: stylelint.Config['rules']) => {
  const { results } = await stylelint.lint({
    code: read(name),
    codeFilename: join(fixtures, name),
    config: { customSyntax: fileURLToPath(new URL('../src/syntax.ts', import.meta.url)), rules },
  });
  return results[0].warnings.map(({ line, column, rule }) => `${line}:${column} ${rule}`);
};

describe('Stylelint', () => {
  test('reports warnings at their positions in the file', async () => {
    const warnings = await lint('button.tsx', {
      'color-hex-length': 'short',
      'length-zero-no-unit': true,
      'property-no-unknown': true,
    });
    // `colour` is in a styled-components template, which isn't a block.
    assert.deepEqual(warnings, ['10:10 color-hex-length', '11:13 length-zero-no-unit']);
  });

  test('nested selectors resolve against the placeholder', async () => {
    const warnings = await lint('button.tsx', { 'selector-max-specificity': '0,1,0' });
    assert.deepEqual(warnings, ['13:3 selector-max-specificity']);
  });

  test('Astro and HTML blocks', async () => {
    const rules = { 'length-zero-no-unit': true } as const;
    assert.deepEqual(await lint('card.astro', rules), ['8:29 length-zero-no-unit']);
    assert.deepEqual(await lint('page.html', rules), ['3:29 length-zero-no-unit']);
  });

  test('a file without blocks has no warnings', async () => {
    const warnings = await lint('no-blocks.ts', { 'length-zero-no-unit': true });
    assert.deepEqual(warnings, []);
  });
});
