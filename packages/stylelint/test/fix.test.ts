import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Declaration, Document, Root, Rule } from 'postcss';
import stylelint from 'stylelint';
import { escapeTemplate, parse, stringify } from '../src/syntax.ts';

const syntax = fileURLToPath(new URL('../src/syntax.ts', import.meta.url));

const fix = async (code: string, file: string, rules: stylelint.Config['rules']) => {
  const result = await stylelint.lint({
    code,
    codeFilename: file,
    config: { customSyntax: syntax, rules },
    fix: true,
  });
  return result.code;
};

const script = `import { css, scss } from '@pre.style/core';

export const a = (theme: { border: string }) => css\`
  color: #FFFFFF;
  margin: 0px;
  outline: 0px solid \${theme.border};
  &:hover { color: #AABBCC }
\`;

export const b = scss\`
  $x: 4px;
  padding: 0px $x;
\`;
`;

const rules = { 'color-hex-length': 'short', 'length-zero-no-unit': true } as const;

describe('--fix', () => {
  test('fixes blocks, keeping their ${…} and the code around them', async () => {
    assert.equal(
      await fix(script, '/x/a.tsx', rules),
      `import { css, scss } from '@pre.style/core';

export const a = (theme: { border: string }) => css\`
  color: #FFF;
  margin: 0;
  outline: 0 solid \${theme.border};
  &:hover { color: #ABC }
\`;

export const b = scss\`
  $x: 4px;
  padding: 0 $x;
\`;
`,
    );
  });

  test('an editor applying each fix gets the same result', async () => {
    const { results } = await stylelint.lint({
      code: script,
      codeFilename: '/x/a.tsx',
      config: { customSyntax: syntax, rules },
      computeEditInfo: true,
    });
    const edits = results[0].warnings.map((warning) => warning.fix!);
    assert.equal(edits.length, 5);
    let fixed = script;
    for (const { range, text } of edits.toSorted((a, b) => b.range[0] - a.range[0]))
      fixed = fixed.slice(0, range[0]) + text + fixed.slice(range[1]);
    assert.equal(fixed, await fix(script, '/x/a.tsx', rules));
  });

  test('HTML attributes keep blocks a fix would break', async () => {
    const html = `<p class="css\`font-family: Times New Roman; margin: 0px;\`"></p>
<p class='css\`font-family: Times New Roman;\`'></p>
<p class="css\`margin: 0px;\`"></p>
`;
    assert.equal(
      await fix(html, '/x/a.html', {
        'font-family-name-quotes': 'always-where-recommended',
        'length-zero-no-unit': true,
      }),
      `<p class="css\`font-family: Times New Roman; margin: 0px;\`"></p>
<p class='css\`font-family: "Times New Roman";\`'></p>
<p class="css\`margin: 0;\`"></p>
`,
    );
  });
});

test('an editor gets no change to an HTML block a fix would break', async () => {
  const html = '<p class="css`font-family: Times New Roman;`"></p>\n';
  const { results } = await stylelint.lint({
    code: html,
    codeFilename: '/x/a.html',
    config: {
      customSyntax: syntax,
      rules: { 'font-family-name-quotes': 'always-where-recommended' },
    },
    computeEditInfo: true,
  });
  const [{ fix: edit }] = results[0].warnings;
  const fixed = edit ? html.slice(0, edit.range[0]) + edit.text + html.slice(edit.range[1]) : html;
  assert.equal(fixed, html);
});

describe('escaping template literals', () => {
  test('backticks and ${ a fix writes are escaped, and escaped ones are kept', () => {
    assert.equal(
      escapeTemplate('a`b ${c} \\`d \\${e} \\\\`f'),
      'a\\`b \\${c} \\`d \\${e} \\\\\\`f',
    );
  });

  test('in blocks', () => {
    const code =
      'import { css } from \'@pre.style/core\';\nexport const a = css`content: "\\`";`;\n';
    const document = parse(code, { from: '/x/a.ts' }) as Document;
    let out = '';
    stringify(document, (part) => (out += part));
    assert.equal(out, code);
    const declaration = ((document.first as Root).first as Rule).first as Declaration;
    declaration.value = '"`${x}"';
    out = '';
    stringify(document, (part) => (out += part));
    assert.equal(out, code.replace('"\\`"', '"\\`\\${x}"'));
  });
});
