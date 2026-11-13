import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import stylelint from 'stylelint';
import { languageOptions } from '../src/config.ts';
import { clearStylesheetIndexes, isStylesheet, namedStylesheets } from '../src/stylesheets.ts';

const project = fileURLToPath(new URL('stylesheets/', import.meta.url));
const path = (name: string) => join(project, name);
const syntax = fileURLToPath(new URL('../src/syntax.ts', import.meta.url));

describe('stylesheets a file names', () => {
  test('imports with type pre.style, and files blocks compose from', () => {
    const file = path('src/button.tsx');
    assert.deepEqual(namedStylesheets(file, readFileSync(file, 'utf8')), [
      path('src/button.css'),
      path('shared/base.css'),
    ]);
  });

  test('imports in Astro components', () => {
    const file = path('src/card.astro');
    assert.deepEqual(namedStylesheets(file, readFileSync(file, 'utf8')), [path('src/card.scss')]);
  });

  test('files a stylesheet composes from, but not from global', () => {
    for (const name of ['src/button.css', 'src/card.scss']) {
      const file = path(name);
      assert.deepEqual(
        namedStylesheets(file, readFileSync(file, 'utf8')),
        name === 'src/button.css' ? [path('src/chip.css')] : [],
      );
    }
  });
});

describe('which files are pre.style stylesheets', () => {
  afterEach(clearStylesheetIndexes);

  test('imported, composed from by a block, and composed from by a stylesheet', () => {
    for (const name of ['src/button.css', 'src/card.scss', 'shared/base.css', 'src/chip.css'])
      assert.ok(isStylesheet(path(name)), name);
  });

  test('not plain CSS imports, or imports in excluded files', () => {
    assert.ok(!isStylesheet(path('src/global.css')));
    assert.ok(!isStylesheet(path('src/excluded/other.css')));
  });

  test('a new import is found once the index is checked again', async (t) => {
    const file = path('src/button.tsx');
    const code = readFileSync(file, 'utf8');
    t.after(() => writeFileSync(file, code));
    assert.ok(!isStylesheet(path('src/global.css')));
    writeFileSync(
      file,
      code.replace("import './global.css';", "import './global.css' with { type: 'pre.style' };"),
    );
    // Trusted for a second, so one lint run scans once.
    assert.ok(!isStylesheet(path('src/global.css')));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1500 });
    assert.ok(isStylesheet(path('src/global.css')));
  });
});

const lint = async (name: string, options = languageOptions) => {
  const { results } = await stylelint.lint({
    files: [path(name)],
    config: {
      customSyntax: syntax,
      languageOptions: options,
      rules: { 'declaration-property-value-no-unknown': true, 'property-no-unknown': true },
    },
  });
  return results[0].warnings.map(
    ({ line, column, rule }) => `${relative(project, path(name))}:${line}:${column} ${rule}`,
  );
};

describe('composes', () => {
  test('is an unknown property without its syntax', async () => {
    assert.deepEqual(await lint('src/button.css', {} as typeof languageOptions), [
      'src/button.css:2:3 property-no-unknown',
      'src/button.css:7:3 property-no-unknown',
    ]);
  });

  test('is a known property, and its value is checked', async () => {
    assert.deepEqual(await lint('src/button.css'), [
      'src/button.css:7:13 declaration-property-value-no-unknown',
    ]);
  });

  test('in blocks', async () => {
    assert.deepEqual(await lint('src/button.tsx'), []);
  });
});
