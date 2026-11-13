import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import stylelint from 'stylelint';
import plugins from '../src/index.ts';

const project = fileURLToPath(new URL('compile/', import.meta.url));
const syntax = fileURLToPath(new URL('../src/syntax.ts', import.meta.url));

const lint = async (name: string, options: object | true = true) => {
  const { results } = await stylelint.lint({
    files: [join(project, 'src', name)],
    config: { customSyntax: syntax, plugins, rules: { 'pre-style/compile': options } },
  });
  return results.flatMap(({ source, warnings }) =>
    warnings.map(
      ({ line, column, text }) =>
        `${relative(project, source!)}:${line}:${column} ${text.replace(' (pre-style/compile)', '')}`,
    ),
  );
};

describe('pre-style/compile', () => {
  test('blocks and stylesheets that compile, with prepended Sass, have no problems', async () => {
    assert.deepEqual(await lint('good.tsx'), []);
  });

  test("reports the build's errors where they are", async () => {
    assert.deepEqual(await lint('bad.tsx'), [
      'src/bad.tsx:3:20 `css` from pre.style can only be used as a tagged template (css`…`).',
      'src/bad.tsx:6:11 Sass failed to compile the block: Undefined variable.',
      'src/bad.tsx:11:7 Invalid CSS: Invalid token in pseudo element: Colon',
      "src/bad.tsx:17:5 `${…}` can only be used in a declaration's value, because it becomes a `var()`, which isn't valid in selectors, property names, or at-rule conditions. To share media queries, use Sass variables.",
      "src/bad.tsx:22:30 `composes` must come before the rule's other declarations, and can't be used inside nested selectors or at-rules.",
    ]);
  });

  test('a misused tag in a file without blocks', async () => {
    assert.deepEqual(await lint('only-misused.ts'), [
      'src/only-misused.ts:3:20 `css` from pre.style can only be used as a tagged template (css`…`).',
    ]);
  });

  test('`${…}` in an Astro component only in client scripts', async () => {
    assert.deepEqual(await lint('page.astro'), [
      "src/page.astro:4:20 `${…}` can't be used in an Astro component's frontmatter or template, because that code only runs on the server, so nothing could set the value in the browser. Use a client script or an island, or `style`.",
    ]);
  });

  test('pre.style stylesheets are compiled, and plain CSS is not', async () => {
    assert.deepEqual(await lint('card.css'), [
      `src/card.css:1:1 ${join(project, 'src/chip.css')} has no class \`missing\` to compose.`,
    ]);
    assert.deepEqual(await lint('global.css'), []);
  });

  test('rejects invalid options', async () => {
    const { results } = await stylelint.lint({
      code: "import { css } from '@pre.style/core';\nexport const a = css`color: red;`;\n",
      codeFilename: join(project, 'src/good.tsx'),
      config: { customSyntax: syntax, plugins, rules: { 'pre-style/compile': 'yes' } },
    });
    assert.equal(results[0].invalidOptionWarnings.length, 1);
  });
});
