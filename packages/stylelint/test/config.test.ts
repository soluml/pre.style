import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import postcssScss from 'postcss-scss';
import stylelint from 'stylelint';
import { preStyle, type PreStyleOptions } from '../src/index.ts';

const project = fileURLToPath(new URL('compile/', import.meta.url));

const lint = async (files: string, options: PreStyleOptions = {}) => {
  const { results } = await stylelint.lint({
    files: [join(project, files)],
    config: {
      // A config that sets its own syntax, as `stylelint-config-standard-scss`
      // does, comes first.
      extends: [{ customSyntax: postcssScss }, preStyle({ packages: [project], ...options })],
      rules: { 'length-zero-no-unit': true, 'property-no-unknown': true },
    },
  });
  return results
    .flatMap(({ source, warnings }) =>
      warnings.map(
        ({ line, column, rule }) => `${relative(project, source!)}:${line}:${column} ${rule}`,
      ),
    )
    .toSorted();
};

describe('preStyle()', () => {
  test('lints blocks and stylesheets, with composes and prepended files', async () => {
    assert.deepEqual(await lint('src/*'), [
      'src/bad.tsx:11:7 pre-style/compile',
      'src/bad.tsx:17:5 pre-style/compile',
      'src/bad.tsx:22:30 pre-style/compile',
      'src/bad.tsx:3:20 pre-style/compile',
      'src/bad.tsx:6:11 pre-style/compile',
      'src/card.css:1:1 pre-style/compile',
      'src/only-misused.ts:3:20 pre-style/compile',
      'src/page.astro:4:20 pre-style/compile',
    ]);
  });

  test("include and exclude replace the field's", async () => {
    assert.deepEqual(await lint('src/*.{ts,tsx}', { exclude: 'src/bad.tsx' }), [
      'src/only-misused.ts:3:20 pre-style/compile',
    ]);
    assert.deepEqual(await lint('src/*.{ts,tsx}', { include: 'src/good.tsx' }), []);
  });

  test('passes lightningcss to the compile rule', () => {
    assert.deepEqual(preStyle({ packages: [project] }).rules, { 'pre-style/compile': true });
    assert.deepEqual(
      preStyle({ packages: [project], lightningcss: { errorRecovery: true } }).rules,
      { 'pre-style/compile': [true, { lightningcss: { errorRecovery: true } }] },
    );
  });
});
