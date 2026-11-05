import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompiler, interpolatedBlock, PreStyleError } from '../../src/compiler/index.ts';
import type { Lang } from '../../src/compiler/index.ts';
import { format } from './helpers.ts';

// A block as the bundler plugin passes it, from a template literal's parts.
// Expressions are named by their source.
function block(strings: TemplateStringsArray, ...expressions: string[]) {
  return { strings: [...strings.raw], expressions, lang: 'css' as Lang };
}

async function compile(...inputs: ReturnType<typeof block>[]) {
  const compiler = await createCompiler({ lightningcss: { minify: true } });
  const blocks = inputs.map((input) => interpolatedBlock(input));
  for (const b of blocks) compiler.scan(b);
  compiler.assignNames();
  return {
    classes: blocks.map((b) => compiler.classString(b)),
    variables: blocks.map((b) => compiler.variables(b)),
    css: format(compiler.css().code),
  };
}

const scss = (strings: TemplateStringsArray, ...expressions: string[]) => ({
  ...block(strings, ...expressions),
  lang: 'scss' as Lang,
});

const rejects = (input: ReturnType<typeof block>, message: RegExp) =>
  assert.throws(
    () => interpolatedBlock(input),
    (error: Error) => {
      assert.ok(error instanceof PreStyleError);
      assert.match(error.message, message);
      return true;
    },
  );

describe('runtime values', () => {
  test('a value becomes a variable, with its unit in the slot', async () => {
    const { classes, variables, css } = await compile(block`width: ${'w'}px;`);
    assert.deepEqual(classes, ['A']);
    assert.deepEqual(variables, [
      [{ name: 'A', property: '--A', slot: { strings: ['', 'px'], expressions: [0] } }],
    ]);
    assert.equal(css, '@property --A{syntax:"*";inherits:false}\n.A{width:var(--A)}');
  });

  test('`var()` around a value sets its default', async () => {
    const { classes, variables, css } = await compile(block`width: var(${'w'}px, 120px);`);
    assert.deepEqual(classes, ['A']);
    assert.deepEqual(variables[0][0].slot, { strings: ['', 'px'], expressions: [0] });
    assert.equal(css, '@property --A{syntax:"*";inherits:false}\n.A{width:var(--A,120px)}');
  });

  test('values in one `var()` share a variable', async () => {
    const { variables, css } = await compile(block`margin: var(${'y'}px ${'x'}px, auto);`);
    assert.deepEqual(
      variables[0].map((v) => v.slot),
      [{ strings: ['', 'px ', 'px'], expressions: [0, 1] }],
    );
    assert.match(css, /\.A\{margin:var\(--A,auto\)\}/);
  });

  test('separate values get separate variables', async () => {
    const { variables, css } = await compile(block`margin-top: calc(${'a'}px + ${'b'}px);`);
    assert.equal(variables[0].length, 2);
    assert.equal(css.match(/@property/g)!.length, 2);
    assert.match(css, /margin-top:calc\(var\(--\w+\) \+ var\(--\w+\)\)/);
  });

  test('a value can start a token', async () => {
    const { variables } = await compile(block`color: #${'hex'};`);
    assert.deepEqual(variables[0][0].slot, { strings: ['#', ''], expressions: [0] });
  });

  test('the same declaration shares a variable and class across blocks', async () => {
    const { classes, variables, css } = await compile(
      block`width: ${'a'}px;`,
      block`width: ${'b'}em;`,
    );
    assert.equal(classes[0], classes[1]);
    assert.equal(variables[0][0].name, variables[1][0].name);
    assert.deepEqual(variables[1][0].slot.strings, ['', 'em']);
    assert.equal(css.match(/@property/g)!.length, 1);
  });

  test('a different default is a different class with the same variable', async () => {
    const { classes, variables } = await compile(
      block`width: var(${'a'}, 1px);`,
      block`width: var(${'b'}, 2px);`,
    );
    assert.notEqual(classes[0], classes[1]);
    assert.equal(variables[0][0].name, variables[1][0].name);
  });

  test('different selector variants get different variables', async () => {
    const { variables } = await compile(block`width: ${'a'}px; &:hover { width: ${'b'}px; }`);
    assert.notEqual(variables[0][0].name, variables[0][1].name);
  });

  test('atoms match the same `var()` written by hand', async () => {
    const { css } = await compile(block`width: var(${'a'}, 1px); color: red;`);
    assert.match(css, /\.\w\{color:red\}/);
    assert.match(css, /\.\w\{width:var\(--A,1px\)\}/);
  });

  test('an overridden declaration drops its variable', async () => {
    const { variables } = await compile(block`width: ${'a'}px; width: ${'b'}px;`);
    assert.deepEqual(
      variables[0].map((v) => v.slot.expressions),
      [[1]],
    );
  });

  test('a shorthand stays one class', async () => {
    const { classes, css } = await compile(block`margin: ${'m'}px;`);
    assert.equal(classes[0], 'A');
    assert.match(css, /\.A\{margin:var\(--A\)\}/);
  });

  test('`!important` is kept', async () => {
    const { css } = await compile(block`width: ${'w'}px !important;`);
    assert.match(css, /\.A\{width:var\(--A\)!important\}/);
  });

  test('values under at-rules and selectors', async () => {
    const { css } = await compile(
      block`@media (min-width: 768px) { &:hover { width: ${'w'}px; } }`,
    );
    assert.match(css, /\.A:hover\{width:var\(--A\)\}/);
  });

  test('a comment drops its expression', async () => {
    const { variables } = await compile(block`/* ${'a'} */ width: ${'b'}px;`);
    assert.deepEqual(variables[0][0].slot.expressions, [1]);
  });

  test('blocks without values have no variables', async () => {
    const compiler = await createCompiler();
    assert.deepEqual(compiler.variables({ code: 'color: red;', lang: 'css' }), []);
  });
});

describe('custom properties', () => {
  test('a custom property set to a value sets it directly', async () => {
    const { classes, variables, css } = await compile(
      block`--brand: ${'color'}; color: var(--brand);`,
    );
    assert.deepEqual(classes, ['A']);
    assert.equal(variables[0][0].property, '--brand');
    assert.equal(css, '.A{color:var(--brand)}');
  });

  test('a hand-written `@property` is kept, for its default', async () => {
    const { variables, css } = await compile(
      block`@property --brand { syntax: "<color>"; inherits: false; initial-value: #f00; } --brand: ${'c'}; color: var(--brand);`,
    );
    assert.equal(variables[0][0].property, '--brand');
    assert.equal(
      css,
      '@property --brand{syntax:"<color>";inherits:false;initial-value:red}\n.A{color:var(--brand)}',
    );
  });

  test('a default goes through a variable', async () => {
    const { variables, css } = await compile(block`--brand: var(${'c'}, #f00);`);
    assert.equal(variables[0][0].property, '--A');
    assert.match(css, /\.A\{--brand:var\(--A,red\)\}/);
  });

  test('under a selector variant, it goes through a variable', async () => {
    const { variables, css } = await compile(block`&:hover { --brand: ${'c'}; }`);
    assert.equal(variables[0][0].property, '--A');
    assert.match(css, /\.A:hover\{--brand:var\(--A\)\}/);
  });

  test('`!important` goes through a variable', async () => {
    const { variables } = await compile(block`--brand: ${'c'} !important;`);
    assert.equal(variables[0][0].property, '--A');
  });

  test('other tokens in the value go through a variable', async () => {
    const { variables, css } = await compile(block`--gap: ${'a'}px ${'b'}px;`);
    assert.equal(variables[0].length, 2);
    assert.match(css, /--gap:var\(--\w+\) var\(--\w+\)/);
  });
});

describe('scss', () => {
  test('values pass through Sass', async () => {
    const { variables, css } = await compile(
      scss`$d: 1px; margin-top: $d; width: var(${'w'}px, $d * 2); @media (min-width: 1px) { color: ${'c'}; }`,
    );
    assert.equal(variables[0].length, 2);
    assert.match(css, /width:var\(--\w+,2px\)/);
  });

  test('a Sass variable holding a value makes a variable per use', async () => {
    const { variables } = await compile(scss`$v: ${'a'}; width: $v; height: $v;`);
    assert.deepEqual(
      variables[0].map((v) => v.slot.expressions),
      [[0], [0]],
    );
    assert.notEqual(variables[0][0].name, variables[0][1].name);
  });

  test('`//` comments drop their expressions', async () => {
    const { variables } = await compile(
      scss`// ${'a'}
width: ${'b'}px;`,
    );
    assert.deepEqual(variables[0][0].slot.expressions, [1]);
  });

  test('a selector built with Sass is still an error', async () => {
    await assert.rejects(compile(scss`$v: ${'a'}; #{$v} { color: red; }`), PreStyleError);
  });
});

describe('errors', () => {
  const POSITION = /can only be used in a declaration's value/;

  test('in a selector', () => {
    rejects(block`.${'a'} { color: red; }`, POSITION);
    rejects(block`&:hover ${'a'} { color: red; }`, POSITION);
    rejects(block`${'a'} { color: red; }`, POSITION);
  });
  test('in a property name', () => {
    rejects(block`${'a'}: red;`, POSITION);
    rejects(block`margin-${'side'}: 0;`, POSITION);
  });
  test('in an at-rule condition', () => {
    rejects(block`@media (min-width: ${'bp'}px) { color: red; }`, POSITION);
    rejects(block`@supports (display: ${'d'}) { color: red; }`, POSITION);
  });
  test('in at-rules written as they are', () => {
    const message = /written to the CSS file as it is/;
    rejects(block`@keyframes a { from { width: ${'w'}; } }`, message);
    rejects(block`@property --a { syntax: "*"; inherits: ${'i'}; }`, message);
    rejects(block`@font-face { font-family: ${'f'}; }`, message);
  });
  test('in a quoted string or `url()`', () => {
    const message = /inside a quoted string or `url\(\)`.*JSON\.stringify/;
    rejects(block`content: "${'label'}";`, message);
    rejects(block`content: 'a${'label'}';`, message);
    rejects(block`background-image: url(${'path'});`, message);
    rejects(block`background-image: url("${'path'}");`, message);
    rejects(block`width: var("${'a'}", 1px);`, message);
  });
  test("as a function's name", () => {
    rejects(block`width: ${'fn'}(1px);`, /function's name/);
  });
  test('positions point to the expression', () => {
    const multiline = block`
      color: red; /* ${'one\ntwo'} */
      .${'a'} { color: red; }
    `;
    assert.throws(
      () => interpolatedBlock({ ...multiline, file: 'a.ts', line: 10, column: 5 }),
      (error: Error) => {
        assert.ok(error instanceof PreStyleError);
        assert.deepEqual(error.position, { line: 3, column: 8 });
        assert.match(error.message, /^a\.ts:13:8: /);
        return true;
      },
    );
  });
});

describe('positions', () => {
  test('lines after a value stay in place', async () => {
    const input = block`width: ${'a\nb\nc'}px;
..x { color: red; }`;
    const compiler = await createCompiler();
    const b = interpolatedBlock({ ...input, file: 'a.ts', line: 1, column: 1 });
    assert.throws(
      () => compiler.classString(b),
      (error: Error) => {
        assert.match(error.message, /^a\.ts:4:/);
        return true;
      },
    );
  });
});

describe('source maps', () => {
  test('a block with values maps to its file', async () => {
    const compiler = await createCompiler({ sourceMap: true });
    const b = interpolatedBlock({ ...block`width: ${'a'}px;`, file: '/a.ts', line: 1, column: 1 });
    compiler.classString(b);
    const { code, map } = compiler.css();
    assert.match(code, /width: var\(--A\)/);
    assert.deepEqual(JSON.parse(map!).sources, ['/a.ts']);
  });
});

describe('quirks mode', () => {
  test('variable names have no uppercase letters', async () => {
    const compiler = await createCompiler({ quirksMode: true });
    const b = interpolatedBlock(block`width: ${'a'}px;`);
    compiler.scan(b);
    compiler.assignNames();
    assert.match(compiler.variables(b)[0].name, /^[^A-Z]+$/);
  });
});
