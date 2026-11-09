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
      [
        {
          name: 'A',
          property: '--A',
          slot: { strings: ['', 'px'], expressions: [0] },
          selector: null,
        },
      ],
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

  test('a declaration on the element is set on the element', async () => {
    for (const input of [
      block`width: ${'w'}px;`,
      block`&:hover { width: ${'w'}px; }`,
      block`.dark & { width: ${'w'}px; }`,
      block`&.a:focus-visible { width: ${'w'}px; }`,
      block`@media (width > 1px) { &:hover { width: ${'w'}px; } }`,
    ])
      assert.equal((await compile(input)).variables[0][0].selector, null);
  });

  test('a declaration elsewhere is set where it is', async () => {
    const selector = async (input: ReturnType<typeof block>) =>
      (await compile(input)).variables[0][0].selector;
    assert.deepEqual(await selector(block`&::before { content: ${'c'}; }`), ['', ':before']);
    assert.deepEqual(await selector(block`&:hover::after { content: ${'c'}; }`), [
      '',
      ':hover:after',
    ]);
    assert.deepEqual(await selector(block`& > * { width: ${'w'}px; }`), ['', ' > *']);
    assert.deepEqual(await selector(block`& + li { width: ${'w'}px; }`), ['', ' + li']);
    assert.deepEqual(await selector(block`.dark & > a { width: ${'w'}px; }`), ['.dark ', ' > a']);
    assert.deepEqual(await selector(block`& a, &::before { width: ${'w'}px; }`), [
      '',
      ' a, ',
      ':before',
    ]);
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

  test('a value after a fallback replaces it, since a `var()` always parses', async () => {
    const { css } = await compile(block`height: 100%; height: ${'h'};`);
    assert.match(css, /^\.A\{height:var\(--A\)\}$/m);
  });

  test('a value before a fallback is kept', async () => {
    const { css, variables } = await compile(block`height: ${'h'}; height: 100svh;`);
    assert.match(css, /\.A\{height:var\(--A\);height:100svh\}/);
    assert.deepEqual(
      variables[0].map((v) => v.slot.expressions),
      [[0]],
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

describe('quoted strings', () => {
  test('the whole string is the value, and its expressions are escaped', async () => {
    const { classes, variables, css } = await compile(block`content: "Count: ${'i'}";`);
    assert.deepEqual(classes, ['A']);
    assert.deepEqual(variables[0][0].slot, { strings: ['"Count: ', '"'], expressions: [~0] });
    assert.match(css, /\.A\{content:var\(--A\)\}/);
  });

  test('single quotes', async () => {
    const { variables } = await compile(block`content: '${'i'}';`);
    assert.deepEqual(variables[0][0].slot, { strings: ["'", "'"], expressions: [~0] });
  });

  test('with a default', async () => {
    const { variables, css } = await compile(block`content: var("${'i'}", "0");`);
    assert.deepEqual(variables[0][0].slot, { strings: ['"', '"'], expressions: [~0] });
    assert.match(css, /content:var\(--A,"0"\)/);
  });

  test('with `type()`', async () => {
    const { variables, css } = await compile(block`--l: var("${'i'}" type(<string>), "0");`);
    assert.deepEqual(variables[0][0].slot.expressions, [~0]);
    assert.match(css, /syntax:"<string>";inherits:false;initial-value:"0"/);
  });

  test('later expressions keep their own index', async () => {
    const { variables } = await compile(block`width: ${'a'}px; content: "${'b'} ${'c'}";`);
    const content = variables[0].find((v) => v.slot.expressions.length === 2)!;
    assert.deepEqual(content.slot.expressions, [~1, ~2]);
    assert.deepEqual(content.slot.strings, ['"', ' ', '"']);
  });

  test('a quote in the text is not the end of the string', async () => {
    const { variables } = await compile(block`content: "a\"b ${'c'}";`);
    assert.deepEqual(variables[0][0].slot.expressions, [~0]);
  });

  test('only values in the quotes are escaped', async () => {
    const { variables } = await compile(block`--x: var(${'a'} "${'b'}", 1);`);
    assert.deepEqual(variables[0][0].slot.expressions, [0, ~1]);
  });

  test('strings without expressions are unchanged', async () => {
    const { css } = await compile(block`content: "a"; width: ${'w'}px;`);
    assert.match(css, /content:"a"/);
  });

  test('`url()`', async () => {
    const { variables, css } = await compile(block`background-image: url("${'path'}");`);
    assert.deepEqual(variables[0][0].slot, { strings: ['url("', '")'], expressions: [~0] });
    assert.match(css, /background-image:var\(--A\)/);
  });

  test('`url()` with text, and a default', async () => {
    const { variables, css } = await compile(
      block`background-image: var(url('/img/${'name'}.png'), none);`,
    );
    assert.deepEqual(variables[0][0].slot.strings, ["url('/img/", ".png')"]);
    assert.match(css, /background-image:var\(--A,none\)/);
  });

  test('`url()` without expressions is unchanged', async () => {
    const { css } = await compile(block`background-image: url("a.png"); width: ${'w'}px;`);
    assert.match(css, /url\("?a\.png"?\)/);
  });

  test('on a pseudo-element', async () => {
    const { variables } = await compile(block`&::before { content: "${'i'}"; }`);
    assert.deepEqual(variables[0][0].selector, ['', ':before']);
  });

  test('in scss', async () => {
    const { variables } = await compile({
      ...block`$d: 1px; margin-top: $d; content: "${'i'}";`,
      lang: 'scss',
    });
    assert.deepEqual(variables[0][0].slot.expressions, [~0]);
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

  test('a property Lightning CSS leaves unparsed still makes an atom', async () => {
    const { classes, variables, css } = await compile(block`content: ${'label'};`);
    assert.deepEqual(classes, ['A']);
    assert.equal(variables[0][0].property, '--A');
    assert.match(css, /\.A\{content:var\(--A\)\}/);
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

describe('`type()`', () => {
  test('a typed variable uses its default as `initial-value`', async () => {
    const { classes, variables, css } = await compile(
      block`width: var(${'w'}px type(<length>), 120px);`,
    );
    assert.deepEqual(classes, ['A']);
    assert.deepEqual(variables[0][0].slot, { strings: ['', 'px'], expressions: [0] });
    assert.equal(
      css,
      '@property --A{syntax:"<length>";inherits:false;initial-value:120px}\n.A{width:var(--A)}',
    );
  });

  test('the type follows every value in the argument', async () => {
    const { variables, css } = await compile(
      block`margin-top: var(${'a'}px ${'b'}px type(<length>+), 0px);`,
    );
    assert.equal(variables[0].length, 1);
    assert.deepEqual(variables[0][0].slot.strings, ['', 'px ', 'px']);
    assert.match(css, /syntax:"<length>\+"/);
  });

  test('keywords and combinators', async () => {
    const { css } = await compile(block`width: var(${'w'} type(<length> | auto), auto);`);
    assert.match(css, /syntax:"<length>\|auto";inherits:false;initial-value:auto/);
  });

  test('`type(*)` is the same as no type', async () => {
    const { css } = await compile(block`width: var(${'w'} type(*), 1px);`);
    assert.equal(css, '@property --A{syntax:"*";inherits:false}\n.A{width:var(--A,1px)}');
  });

  test('each type and default has its own variable', async () => {
    const { classes, variables, css } = await compile(
      block`width: var(${'a'} type(<length>), 1px);`,
      block`width: var(${'b'} type(<length>), 2px);`,
      block`width: var(${'c'} type(<length>), 1px);`,
      block`width: var(${'d'} type(<length-percentage>), 1px);`,
    );
    assert.equal(classes[0], classes[2]);
    assert.notEqual(classes[0], classes[1]);
    assert.notEqual(variables[0][0].name, variables[1][0].name);
    assert.equal(variables[0][0].name, variables[2][0].name);
    assert.notEqual(variables[0][0].name, variables[3][0].name);
    assert.equal(css.match(/@property/g)!.length, 3);
  });

  test('blocks that differ only by type stay separate', async () => {
    const { css } = await compile(
      block`color: var(${'a'} type(<color>), red);`,
      block`color: var(${'b'} type(<custom-ident>), red);`,
    );
    assert.match(css, /syntax:"<color>"/);
    assert.match(css, /syntax:"<custom-ident>"/);
  });

  test('a custom property registers itself', async () => {
    const { classes, variables, css } = await compile(
      block`--brand: var(${'c'} type(<color>), #f00); color: var(--brand);`,
    );
    assert.deepEqual(classes, ['A']);
    assert.equal(variables[0][0].property, '--brand');
    assert.equal(
      css,
      '@property --brand{syntax:"<color>";inherits:false;initial-value:red}\n.A{color:var(--brand)}',
    );
  });

  test('under a selector variant, a custom property goes through a variable', async () => {
    const { variables, css } = await compile(
      block`&:hover { --brand: var(${'c'} type(<color>), #f00); }`,
    );
    assert.equal(variables[0][0].property, '--A');
    assert.match(css, /@property --A\{syntax:"<color>"/);
    assert.match(css, /\.A:hover\{--brand:var\(--A\)\}/);
  });

  test('in `@keyframes`', async () => {
    const { css } = await compile(
      block`@keyframes k { to { width: var(${'w'}px type(<length>), 10px); } }`,
    );
    assert.match(css, /@property --A\{syntax:"<length>";inherits:false;initial-value:10px\}/);
    assert.match(css, /to\{width:var\(--A\)\}/);
  });

  test('a default computed by Sass', async () => {
    const { css } = await compile({
      ...block`$d: 2px; width: var(${'w'} type(<length>), $d * 2);`,
      lang: 'scss',
    });
    assert.match(css, /initial-value:4px/);
  });

  test('a default can mention a unit in a string', async () => {
    const { css } = await compile(block`--label: var(${'l'} type(<string>), "1em");`);
    assert.match(css, /initial-value:"1em"/);
  });

  test('absolute and viewport units, `currentColor`, and percentages are allowed', async () => {
    await compile(block`width: var(${'w'} type(<length>), 1in);`);
    await compile(block`width: var(${'w'} type(<length>), 1vw);`);
    await compile(block`color: var(${'c'} type(<color>), currentColor);`);
    await compile(block`width: var(${'w'} type(<length-percentage>), calc(10% + 1px));`);
  });

  describe('Sass interpolation elsewhere', () => {
    test('`#{…}` before a value, in another token', async () => {
      const { variables, css } = await compile({
        ...block`$a: 1px; margin: #{$a} ${'v'}px;`,
        lang: 'scss',
      });
      assert.equal(variables[0].length, 1);
      assert.match(css, /margin:1px var\(--A\)/);
    });
  });

  describe('errors', () => {
    test('no default', () => {
      rejects(block`width: var(${'w'} type(<length>));`, /`type\(\)` needs a default/);
    });
    test('a runtime value in the default or type', () => {
      const message = /can't use `\$\{…\}`/;
      rejects(block`width: var(${'w'} type(<length>), ${'d'});`, message);
      rejects(block`width: var(--x type(${'t'}), 1px);`, message);
    });
    test('a default of the wrong type', async () => {
      await assert.rejects(
        compile(block`color: var(${'c'} type(<color>), 10px);`),
        /`10px` can't be the default of `type\(<color>\)`: it isn't valid/,
      );
    });
    test('an unknown type', async () => {
      await assert.rejects(
        compile(block`color: var(${'c'} type(<nope>), 10px);`),
        /can't be the default of `type\(<nope>\)`/,
      );
    });
    test("a default that depends on where it's used", async () => {
      for (const value of ['1em', '1rem', '1ch', '1cqw', 'calc(1px + 1em)']) {
        const input = block`width: var(${'w'} type(<length>), 0px);`;
        input.strings[1] = input.strings[1].replace('0px', value);
        await assert.rejects(compile(input), /can't depend on where it's used/);
      }
      await assert.rejects(
        compile(block`width: var(${'w'} type(<length>), env(safe-area-inset-top));`),
        /can't depend on where it's used/,
      );
    });
    test('`var()` in a default', async () => {
      await assert.rejects(
        compile(block`width: var(${'w'} type(<length>), var(--x));`),
        /isn't valid/,
      );
    });
  });
});

describe('at-rules that read values from the element', () => {
  test('`@keyframes`', async () => {
    const { classes, variables, css } = await compile(
      block`@keyframes grow { to { width: var(${'w'}px, 10px); } } animation: grow 1s;`,
    );
    assert.deepEqual(variables[0][0].slot, { strings: ['', 'px'], expressions: [0] });
    assert.equal(variables[0][0].property, '--A');
    assert.ok(classes[0].length > 0);
    assert.match(css, /to\{width:var\(--A,10px\)\}/);
    assert.match(css, /@property --A\{syntax:"\*";inherits:false\}/);
  });

  test('the same `@keyframes` in two blocks shares its variable', async () => {
    const { variables, css } = await compile(
      block`color: red; @keyframes a { to { width: ${'x'}px; } }`,
      block`@keyframes a { to { width: ${'y'}em; } }`,
    );
    assert.equal(variables[0][0].name, variables[1][0].name);
    assert.equal(css.match(/@keyframes/g)!.length, 1);
  });

  test('values in `@keyframes` and declarations count their slots in order', async () => {
    const { variables } = await compile(
      block`width: ${'a'}px; @keyframes k { to { height: ${'b'}px; } }`,
    );
    assert.deepEqual(variables[0].map((v) => v.slot.expressions).toSorted(), [[0], [1]]);
  });

  test('`@keyframes` with `keyframeLocalization`', async () => {
    const compiler = await createCompiler({
      keyframeLocalization: true,
      lightningcss: { minify: true },
    });
    const b = interpolatedBlock(block`@keyframes k { to { width: ${'w'}px; } } animation-name: k;`);
    compiler.scan(b);
    compiler.assignNames();
    assert.equal(compiler.variables(b).length, 1);
    assert.doesNotMatch(compiler.css().code, /pre\.style|slot/);
  });

  test('`@position-try`', async () => {
    const { variables, css } = await compile(block`@position-try --t { top: ${'y'}px; }`);
    assert.equal(variables[0].length, 1);
    assert.match(css, /@position-try --t\{top:var\(--A\)\}/);
  });

  test('`@function`', async () => {
    const { variables, css } = await compile(block`@function --f() { result: ${'x'}px; }`);
    assert.equal(variables[0].length, 1);
    assert.match(css, /result:\s*var\(--A\)/);
    assert.doesNotMatch(css, /slot/);
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
  test("in at-rules that don't accept `var()`", () => {
    const message = /doesn't accept `var\(\)`/;
    rejects(block`@property --a { syntax: "*"; inherits: ${'i'}; }`, message);
    rejects(block`@font-face { font-family: ${'f'}; }`, message);
    rejects(block`@counter-style a { symbols: ${'s'}; }`, message);
    rejects(block`@page { margin: ${'m'}; }`, message);
    rejects(block`@view-transition { navigation: ${'n'}; }`, message);
  });
  test("in a `@keyframes` rule's selector", () => {
    rejects(block`@keyframes a { ${'p'}% { width: 1px; } }`, POSITION);
  });
  test('in an unquoted `url()`', () => {
    rejects(block`background-image: url(${'path'});`, /unquoted `url\(\)`.*url\("\$\{path\}"\)/);
  });
  test('a quoted string in a selector or condition', () => {
    rejects(block`&[data-a="${'v'}"] { color: red; }`, POSITION);
    rejects(block`@supports (content: "${'v'}") { color: red; }`, POSITION);
    rejects(block`@font-face { font-family: "${'f'}"; }`, /doesn't accept `var\(\)`/);
  });
  test('`#{…}` in the same value in scss', () => {
    const lang = 'scss' as Lang;
    rejects({ ...block`content: "#{$a} ${'v'}";`, lang }, /`#\{…\}` can't be used/);
    rejects({ ...block`width: #{$a}${'v'};`, lang }, /`#\{…\}` can't be used/);
    rejects({ ...block`width: ${'v'}#{$a};`, lang }, /`#\{…\}` can't be used/);
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

describe('`cn`', () => {
  test('lists variables, with named custom properties', async () => {
    const compiler = await createCompiler();
    const b = interpolatedBlock(block`width: ${'a'}px; --brand: ${'b'};`);
    compiler.scan(b);
    compiler.assignNames();
    const variables = compiler.cnVariables();
    assert.deepEqual(Object.values(variables).toSorted(), ['', '--brand']);
    assert.ok(variables[compiler.variables(b)[0].name] === '');
  });

  test('a new variable changes the revision, even with no new CSS', async () => {
    const compiler = await createCompiler();
    const { revision } = compiler;
    compiler.classString(interpolatedBlock(block`--brand: ${'c'};`));
    assert.notEqual(compiler.revision, revision);
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
