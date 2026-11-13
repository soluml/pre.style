import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import stylelint from 'stylelint';
import { prependOverrides } from '../src/config.ts';

const project = fileURLToPath(new URL('prepend/', import.meta.url));
const app = join(project, 'app');
const syntax = fileURLToPath(new URL('../src/syntax.ts', import.meta.url));

const rules = {
  'no-unknown-animations': true,
  'no-unknown-custom-media': true,
  'no-unknown-custom-properties': true,
} as const;

const lint = async (config: Partial<stylelint.Config> = {}) => {
  const { results } = await stylelint.lint({
    files: [join(project, '*/src/*.tsx')],
    config: { customSyntax: syntax, rules, ...config },
  });
  return results
    .flatMap(({ source, warnings }) =>
      warnings.map(
        ({ line, column, text }) => `${relative(project, source!)}:${line}:${column} ${text}`,
      ),
    )
    .toSorted();
};

describe('prepended files', () => {
  // The library is a workspace package, linked into the app's node_modules.
  const modules = join(app, 'node_modules');
  before(() => {
    mkdirSync(modules, { recursive: true });
    symlinkSync(join(project, 'ui'), join(modules, 'ui'), 'dir');
  });
  after(() => rmSync(modules, { recursive: true, force: true }));

  test('without them, names from prepended files are unknown', async () => {
    assert.equal((await lint()).length, 9);
  });

  test("each package's files see its own prepended files, css and scss", async () => {
    assert.deepEqual(await lint({ overrides: prependOverrides({ packages: [app] }) }), [
      'app/src/button.tsx:16:21 Unknown custom property "--missing" (no-unknown-custom-properties)',
      'app/src/button.tsx:7:22 Unknown custom property "--accent" (no-unknown-custom-properties)',
      'ui/src/badge.tsx:5:19 Unknown custom property "--brand" (no-unknown-custom-properties)',
    ]);
  });

  test('your own referenceFiles are kept', async () => {
    const theme = join(project, 'ui/theme.css');
    const warnings = await lint({
      overrides: prependOverrides({ packages: [app], referenceFiles: [theme] }),
    });
    assert.ok(!warnings.some((warning) => warning.includes('--accent')));
  });

  test('a package without a pre.style field has no overrides', () => {
    assert.deepEqual(prependOverrides({ packages: [project] }), []);
  });
});
