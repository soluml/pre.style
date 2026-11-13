import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Document, Root } from 'postcss';
import stylelint from 'stylelint';
import { parse, stringify } from '../src/syntax.ts';
import { blockInfo } from '../src/syntax.ts';

const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
const file = join(fixtures, 'styles.astro');
const code = readFileSync(file, 'utf8');
const syntax = fileURLToPath(new URL('../src/syntax.ts', import.meta.url));

const lint = async (config: stylelint.Config, fix = false, codeFilename = file, source = code) => {
  const result = await stylelint.lint({ code: source, codeFilename, config, fix });
  return {
    code: result.code,
    warnings: result.results[0].warnings.map(
      ({ line, column, rule }) => `${line}:${column} ${rule}`,
    ),
  };
};

describe('<style> tags with postcss-html', () => {
  test('are roots of the document, in file order with the blocks', () => {
    const roots = (parse(code, { from: file }) as Document).nodes as Root[];
    assert.deepEqual(
      roots.map(
        (root) =>
          blockInfo(root)?.lang ??
          `style ${(root.source as { lang?: string } | undefined)?.lang ?? ''}`.trim(),
      ),
      ['css', 'scss', 'style css', 'style css', 'style scss'],
    );
    let out = '';
    stringify(parse(code, { from: file }) as Document, (part) => (out += part));
    assert.equal(out, code);
  });

  test('are linted with the blocks, and fixed in place', async () => {
    const rules = { 'length-zero-no-unit': true } as const;
    const { warnings } = await lint({ customSyntax: syntax, rules });
    assert.deepEqual(warnings, [
      '4:12 length-zero-no-unit',
      '12:35 length-zero-no-unit',
      '14:21 length-zero-no-unit',
      // Not `$x: 0px`: the rule skips Sass variables.
      '18:21 length-zero-no-unit',
    ]);
    const fixed = await lint({ customSyntax: syntax, rules }, true);
    assert.equal(fixed.code, code.replaceAll('0px', '0').replace('$x: 0;', '$x: 0px;'));
  });
});

describe('scss blocks', () => {
  test('are linted with the SCSS config, which knows Sass', async () => {
    const { warnings } = await lint({
      extends: ['stylelint-config-standard-scss'],
      customSyntax: syntax,
      rules: {
        'length-zero-no-unit': null,
        'declaration-empty-line-before': null,
        'at-rule-empty-line-before': null,
        'rule-empty-line-before': null,
      },
    });
    // `@include` and `$` variables aren't unknown.
    assert.deepEqual(warnings, []);
  });

  test('warnings on a block as a whole point to the block', async () => {
    const { warnings } = await lint({ customSyntax: syntax, rules: { 'no-such-rule': true } });
    assert.deepEqual(warnings.slice(0, 2), ['3:18 no-such-rule', '6:20 no-such-rule']);
  });
});

describe('lint scope', () => {
  const project = fileURLToPath(new URL('compile/', import.meta.url));
  const block = "import { css } from '@pre.style/core';\nexport const a = css`margin: 0px;`;\n";
  const rules = { customSyntax: syntax, rules: { 'length-zero-no-unit': true } } as const;

  test('a file in include is linted before it is saved', async () => {
    const unsaved = join(project, 'src/unsaved.ts');
    assert.deepEqual((await lint(rules, false, unsaved, block)).warnings, [
      '2:31 length-zero-no-unit',
    ]);
  });

  test('a new file is linted at once', async (t) => {
    const created = join(project, 'src/created.ts');
    t.after(() => rmSync(created, { force: true }));
    // Build the package's index first, then add the file.
    await lint(
      rules,
      false,
      join(project, 'src/good.tsx'),
      readFileSync(join(project, 'src/good.tsx'), 'utf8'),
    );
    writeFileSync(created, block);
    assert.deepEqual((await lint(rules, false, created, block)).warnings, [
      '2:31 length-zero-no-unit',
    ]);
  });
});
