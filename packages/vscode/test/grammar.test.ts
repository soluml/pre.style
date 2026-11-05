import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

// Tokenizes with the engine and grammars VS Code uses, wiring injections the
// way VS Code does from the extension's contributes.grammars.
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const contributed: { scopeName: string; path: string; injectTo?: string[] }[] =
  manifest.contributes.grammars;

const builtIn: Record<string, string> = {
  'source.css': 'css',
  'source.css.scss': 'scss',
  'source.js': 'javascript',
  'source.js.jsx': 'jsx',
  'source.ts': 'typescript',
  'source.tsx': 'tsx',
  'text.html.basic': 'html',
  'source.astro': 'astro',
};

await oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));

const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  async loadGrammar(scopeName) {
    const own = contributed.find((g) => g.scopeName === scopeName);
    if (own) {
      const path = new URL(`../${own.path}`, import.meta.url);
      return vsctm.parseRawGrammar(readFileSync(path, 'utf8'), path.pathname);
    }
    const name = builtIn[scopeName];
    if (!name) return null;
    return JSON.parse(readFileSync(require.resolve(`tm-grammars/grammars/${name}.json`), 'utf8'));
  },
  getInjections: (scopeName) =>
    contributed.filter((g) => g.injectTo?.includes(scopeName)).map((g) => g.scopeName),
});

type Token = { text: string; scopes: string[] };

async function tokenize(scopeName: string, source: string): Promise<Token[]> {
  const grammar = await registry.loadGrammar(scopeName);
  assert.ok(grammar, `no grammar for ${scopeName}`);
  const tokens: Token[] = [];
  let state = vsctm.INITIAL;
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, state);
    for (const t of result.tokens) {
      tokens.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
    }
    state = result.ruleStack;
  }
  return tokens;
}

// The scopes of the nth token whose trimmed text is `text`.
function scopesOf(tokens: Token[], text: string, nth = 0): string[] {
  const found = tokens.filter((t) => t.text.trim() === text)[nth];
  assert.ok(found, `no token "${text}" in ${JSON.stringify(tokens.map((t) => t.text))}`);
  return found.scopes;
}

function has(scopes: string[], prefix: string): boolean {
  return scopes.some((s) => s === prefix || s.startsWith(`${prefix}.`));
}

function assertCss(tokens: Token[], text: string, scope: string, nth = 0) {
  const scopes = scopesOf(tokens, text, nth);
  assert.ok(has(scopes, scope), `"${text}" is not ${scope}: ${scopes.join(' ')}`);
  assert.ok(has(scopes, 'meta.embedded.block.pre-style'), `"${text}" is outside a block`);
}

function assertOutside(tokens: Token[], text: string, nth = 0) {
  const scopes = scopesOf(tokens, text, nth);
  assert.ok(!has(scopes, 'meta.embedded.block.pre-style'), `"${text}" is in a block`);
}

describe('`${…}` in blocks', () => {
  const inExpression = (tokens: Token[], text: string) => {
    const scopes = scopesOf(tokens, text);
    assert.ok(has(scopes, 'meta.embedded.expression.pre-style'), `"${text}": ${scopes.join(' ')}`);
    assert.ok(has(scopes, 'source.js'), `"${text}": ${scopes.join(' ')}`);
  };

  for (const [language, scope] of [
    ['css', 'source.ts'],
    ['css', 'source.tsx'],
    ['css', 'source.js'],
    ['scss', 'source.ts'],
  ]) {
    test(`is JavaScript in a ${language} block in ${scope}`, async () => {
      const tokens = await tokenize(
        scope,
        `const a = ${language}\`width: \${count}px; color: red;\`;\nconst b = 1;`,
      );
      inExpression(tokens, 'count');
      assertCss(tokens, 'color', 'support.type.property-name');
      assertOutside(tokens, 'b');
    });
  }

  test('in a nested rule, an at-rule, and var()', async () => {
    const tokens = await tokenize(
      'source.ts',
      `css\`
  &::before { content: \${first}; }
  @media (min-width: 1px) { width: \${second}px; }
  margin: var(\${third}px, 120px);
  color: red;
\`;`,
    );
    inExpression(tokens, 'first');
    inExpression(tokens, 'second');
    inExpression(tokens, 'third');
    assertCss(tokens, 'color', 'support.type.property-name');
  });

  test('its punctuation', async () => {
    const tokens = await tokenize('source.ts', 'css`width: ${w}px;`;');
    assert.ok(has(scopesOf(tokens, '${'), 'punctuation.definition.template-expression.begin'));
    assert.ok(has(scopesOf(tokens, '}'), 'punctuation.definition.template-expression.end'));
  });

  test('braces in an expression do not end it', async () => {
    const tokens = await tokenize('source.ts', 'css`width: ${{ inner: 1 }.inner}px; color: red;`;');
    inExpression(tokens, 'inner');
    assertCss(tokens, 'color', 'support.type.property-name');
  });

  test('a template in an expression does not end the block', async () => {
    const tokens = await tokenize('source.ts', 'css`width: ${`${inner}px`}; color: red;`;\nb;');
    assertCss(tokens, 'color', 'support.type.property-name');
    assertOutside(tokens, 'b');
  });

  test('blocks without one are unchanged', async () => {
    const tokens = await tokenize('source.ts', 'css`color: red;`;');
    assertCss(tokens, 'color', 'support.type.property-name');
    assertCss(tokens, 'red', 'support.constant.color');
  });
});

describe('css blocks in TypeScript', () => {
  test('declarations, nesting, and at-rules', async () => {
    const tokens = await tokenize(
      'source.ts',
      [
        'const button = css`',
        '  background-color: #0071ba;',
        '  &:hover {',
        '    color: black;',
        '  }',
        '  @media (min-width: 768px) {',
        '    padding-block: 1em;',
        '  }',
        '`;',
        'const after = 1;',
      ].join('\n'),
    );
    assert.ok(has(scopesOf(tokens, 'css'), 'entity.name.function.tagged-template'));
    assertCss(tokens, 'background-color', 'support.type.property-name');
    assertCss(tokens, '0071ba', 'constant.other.color');
    assertCss(tokens, 'hover', 'entity.other.attribute-name.pseudo-class');
    assertCss(tokens, 'color', 'support.type.property-name');
    assertCss(tokens, 'media', 'keyword.control.at-rule.media');
    assertCss(tokens, 'padding-block', 'support.type.property-name');
    assertOutside(tokens, 'after');
    assert.ok(has(scopesOf(tokens, 'const', 1), 'storage.type'));
  });

  test('a last declaration without a semicolon ends at the backtick', async () => {
    const tokens = await tokenize('source.ts', 'const a = css`color: red`; const b = 1;');
    assertCss(tokens, 'red', 'support.constant.color');
    assertOutside(tokens, 'b');
    assert.ok(has(scopesOf(tokens, 'const', 1), 'storage.type'));
  });

  test('custom properties', async () => {
    const tokens = await tokenize('source.ts', 'css`--gap: 1rem; margin: var(--gap);`');
    assertCss(tokens, '--gap', 'variable.css');
    assertCss(tokens, 'var', 'support.function.misc');
  });

  test('only a bare css or scss tag starts a block', async () => {
    const tokens = await tokenize(
      'source.ts',
      'a.css`color: red`; mycss`color: red`; // css`color: red`\n"css`color: red`";',
    );
    assert.ok(tokens.every((t) => !has(t.scopes, 'meta.embedded.block.pre-style')));
  });
});

describe('scss blocks', () => {
  test('variables, nesting, and a last declaration without a semicolon', async () => {
    const tokens = await tokenize(
      'source.ts',
      [
        'const title = scss`',
        '  $size: 2rem;',
        '  font-size: $size;',
        '  &:hover { color: black; }',
        '  margin-bottom: $size / 2',
        '`;',
        'const after = 1;',
      ].join('\n'),
    );
    assertCss(tokens, '$size', 'variable.scss');
    assertCss(tokens, 'font-size', 'support.type.property-name');
    assertCss(tokens, '$size', 'variable.scss', 1);
    assertCss(tokens, 'hover', 'entity.other.attribute-name.pseudo-class');
    assertCss(tokens, 'margin-bottom', 'support.type.property-name');
    assertOutside(tokens, 'after');
  });

  test('a last variable without a semicolon ends at the backtick', async () => {
    const tokens = await tokenize('source.ts', 'scss`$a: 1px`; const b = 1;');
    assertCss(tokens, '$a', 'variable.scss');
    assertOutside(tokens, 'b');
  });
});

describe('other languages', () => {
  test('JavaScript', async () => {
    const tokens = await tokenize('source.js', 'const a = css`color: red;`;');
    assertCss(tokens, 'color', 'support.type.property-name');
  });

  test('JSX and TSX attributes', async () => {
    for (const scope of ['source.js.jsx', 'source.tsx']) {
      const tokens = await tokenize(scope, '<div className={css`color: red`}>Hi</div>');
      assertCss(tokens, 'color', 'support.type.property-name');
      assertOutside(tokens, 'Hi');
    }
  });

  test('HTML class attributes and scripts', async () => {
    const tokens = await tokenize(
      'text.html.basic',
      [
        '<div class="css`color: red`" id="x">Hi</div>',
        '<script>const a = scss`margin: 0;`;</script>',
      ].join('\n'),
    );
    assertCss(tokens, 'color', 'support.type.property-name');
    assertOutside(tokens, 'id');
    assertOutside(tokens, 'Hi');
    assertCss(tokens, 'margin', 'support.type.property-name');
  });

  test('Astro frontmatter, expressions, and scripts', async () => {
    const tokens = await tokenize(
      'source.astro',
      [
        '---',
        'const title = css`font-size: 2rem;`;',
        '---',
        '<h1 class={css`color: red`}>Hi</h1>',
        '<script>const a = css`margin: 0;`;</script>',
      ].join('\n'),
    );
    assertCss(tokens, 'font-size', 'support.type.property-name');
    assertCss(tokens, 'color', 'support.type.property-name');
    assertOutside(tokens, 'Hi');
    assertCss(tokens, 'margin', 'support.type.property-name');
  });

  test('Astro class attributes are not blocks', async () => {
    const tokens = await tokenize('source.astro', '<h1 class="css`color: red`">Hi</h1>');
    assert.ok(tokens.every((t) => !has(t.scopes, 'meta.embedded.block.pre-style')));
  });
});
