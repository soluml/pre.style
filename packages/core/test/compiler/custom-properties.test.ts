import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompiler, interpolatedBlock } from '../../src/compiler/index.ts';
import type { Block, CompilerOptions } from '../../src/compiler/index.ts';
import { compile } from './helpers.ts';

const on = { customPropertyLocalization: true };
const run = (blocks: (string | Block)[], options: CompilerOptions = {}) =>
  compile(blocks, { ...on, ...options });

const block = (strings: TemplateStringsArray, ...expressions: string[]) =>
  interpolatedBlock({ strings: [...strings.raw], expressions, lang: 'css' });

const compileOne = async (input: Block) => {
  const compiler = await createCompiler({ ...on, lightningcss: { minify: true } });
  compiler.scan(input);
  compiler.assignNames();
  compiler.classString(input);
  return {
    variables: compiler.variables(input),
    cn: compiler.cnVariables(),
    css: compiler.css().code,
  };
};

describe('custom property localization', () => {
  test('off by default', async () => {
    const { css } = await compile(['--gap: 1px; margin-top: var(--gap);']);
    assert.match(css, /--gap:1px/);
    assert.match(css, /var\(--gap\)/);
  });

  test('a declared name gets a generated one, wherever it is used', async () => {
    const { css } = await run(['--gap: 1px; margin-top: var(--gap);']);
    assert.doesNotMatch(css, /--gap/);
    const [, name] = /(--\w+):1px/.exec(css)!;
    assert.ok(css.includes(`margin-top:var(${name})`), css);
    assert.doesNotMatch(css, /pre\.style|\\0|\\u0000/);
  });

  test('blocks that each declare a name do not collide', async () => {
    const { css } = await run(['--gap: 1px;', '--gap: 2px;']);
    const names = [...css.matchAll(/(--\w+):[12]px/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
  });

  test('identical blocks share their names and classes', async () => {
    const { classes } = await run(['--gap: 1px;', '--gap: 1px;']);
    assert.equal(classes[0], classes[1]);
  });

  test('a name only read stays global', async () => {
    const { css } = await run(['color: var(--token); --own: 1;']);
    assert.match(css, /color:var\(--token\)/);
    assert.doesNotMatch(css, /--own/);
  });

  test('`transition-property` and `will-change` follow', async () => {
    const { css } = await run(['--x: 1; transition-property: --x, color; will-change: --x;']);
    assert.doesNotMatch(css, /--x/);
    assert.match(css, /transition-property:--\w+,color/);
    assert.match(css, /will-change:--\w+/);
  });

  test('the `transition` shorthand follows', async () => {
    const { css } = await run(['--x: 1; transition: --x 1s;']);
    assert.doesNotMatch(css, /--x/);
  });

  test('`@property` follows', async () => {
    const { css } = await run([
      '@property --x { syntax: "<color>"; inherits: false; initial-value: red; } --x: blue; color: var(--x);',
    ]);
    assert.doesNotMatch(css, /--x/);
    assert.match(css, /@property --\w+\{syntax:"<color>"/);
  });

  test('an only-registered name is declared', async () => {
    const { css } = await run([
      '@property --x { syntax: "<color>"; inherits: false; initial-value: red; } color: var(--x);',
    ]);
    assert.doesNotMatch(css, /--x/);
  });

  test('`@keyframes` declarations and reads follow', async () => {
    const { css } = await run([
      '@keyframes k { to { --x: 1; width: var(--y); } } --y: 2px; animation-name: k;',
    ]);
    assert.doesNotMatch(css, /--[xy]\b/);
  });

  test('`@container style()` follows', async () => {
    const { css } = await run(['--x: 1; @container style(--x: 1) { color: red; }']);
    assert.doesNotMatch(css, /--x/);
    assert.match(css, /@container style\(--\w+: ?1\)/);
  });

  test('other dashed names stay', async () => {
    const { css } = await run([
      '--a: 1; anchor-name: --a; position-anchor: --a; width: anchor-size(--a width); view-timeline-name: --a; animation-timeline: --a;',
    ]);
    assert.match(css, /anchor-name:--a/);
    assert.match(css, /position-anchor:--a/);
    assert.match(css, /anchor-size\(--a width\)/);
    assert.match(css, /view-timeline-name:--a/);
    assert.match(css, /animation-timeline:--a/);
  });

  test('fallbacks follow', async () => {
    const { css } = await run(['--a: 1px; --b: 2px; width: var(--c, var(--a, var(--b)));']);
    assert.match(css, /width:var\(--c,var\(--\w+,var\(--\w+\)\)\)/);
    assert.doesNotMatch(css, /--[ab]\b/);
  });

  test('names are stable and scanned by use', async () => {
    const first = await run(['--gap: 1px; margin-top: var(--gap);']);
    const second = await run(['--gap: 1px; margin-top: var(--gap);']);
    assert.equal(first.css, second.css);
  });

  test('`cn` conflicts are by generated name', async () => {
    const compiler = await createCompiler(on);
    const a = { code: '--gap: 1px;', lang: 'css' as const };
    const b = { code: '--gap: 1px; color: red;', lang: 'css' as const };
    compiler.scan(a);
    compiler.scan(b);
    compiler.assignNames();
    compiler.classString(a);
    compiler.classString(b);
    const table = compiler.cnTable();
    const properties = Object.keys(table['']);
    assert.ok(properties.includes('color'));
    assert.equal(properties.filter((p) => p.startsWith('--')).length, 2);
    assert.ok(!properties.some((p) => p.includes('gap') || p.includes('\0')), properties.join());
  });
});

describe('prepended files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre-style-'));
  writeFileSync(
    join(dir, 'tokens.css'),
    ':root { --token: 1px; } @property --reg { syntax: "*"; inherits: false; } @keyframes p { to { width: var(--own); } }',
  );
  writeFileSync(join(dir, '_tokens.scss'), '$x: 1; :root { --scss-token: #{$x}px; }');
  const options = { root: dir, prependFiles: { css: ['tokens.css'], scss: ['_tokens.scss'] } };

  test('their names stay global, in their rules and in blocks', async () => {
    const { css } = await run(['margin-top: var(--token);'], options);
    assert.match(css, /--token:1px/);
    assert.match(css, /margin-top:var\(--token\)/);
  });

  test('a block setting a prepended name still sets the shared one', async () => {
    const { css } = await run(['--token: 2px;'], options);
    assert.match(css, /--token:2px/);
  });

  test('their `@property` stays global', async () => {
    const { css } = await run(['--reg: 1;'], options);
    assert.match(css, /@property --reg/);
    assert.match(css, /--reg:1/);
  });

  test("a block's own name doesn't change a prepended rule", async () => {
    const { css } = await run(['--own: 1px; width: var(--own);'], options);
    assert.match(css, /to\{width:var\(--own\)\}/);
    assert.match(css, /width:var\(--\w\)/);
  });

  test('scss', async () => {
    const { css } = await run(
      [{ code: 'margin-top: var(--scss-token); --mine: 1;', lang: 'scss' }],
      options,
    );
    assert.match(css, /--scss-token:1px/);
    assert.match(css, /margin-top:var\(--scss-token\)/);
    assert.doesNotMatch(css, /--mine/);
  });
});

describe('with runtime values', () => {
  test('a custom property set directly gets the generated name', async () => {
    const { variables, cn, css } = await compileOne(block`--brand: ${'c'}; color: var(--brand);`);
    assert.doesNotMatch(css, /--brand/);
    const { property } = variables[0];
    assert.doesNotMatch(property, /brand|\0/);
    assert.ok(css.includes(`color:var(${property})`), css);
    assert.equal(cn[variables[0].name], property);
  });

  test('`type()` registers the generated name', async () => {
    const { variables, css } = await compileOne(
      block`--brand: var(${'c'} type(<color>), #f00); color: var(--brand);`,
    );
    assert.doesNotMatch(css, /--brand/);
    assert.ok(css.includes(`@property ${variables[0].property}{syntax:"<color>"`), css);
  });

  test('a handwritten `@property` follows', async () => {
    const { variables, css } = await compileOne(
      block`@property --brand { syntax: "<color>"; inherits: false; initial-value: red; } --brand: ${'c'};`,
    );
    assert.ok(css.includes(`@property ${variables[0].property}{`), css);
  });

  test('a generated variable stays separate', async () => {
    const { variables, css } = await compileOne(block`--gap: 1px; width: ${'w'}px;`);
    assert.doesNotMatch(css, /--gap/);
    assert.equal(variables.length, 1);
    assert.notEqual(variables[0].property, /(--\w+):1px/.exec(css)![1]);
  });
});

describe('stylesheet files', () => {
  test('a name is shared by the whole file', async () => {
    const compiler = await createCompiler({ ...on, lightningcss: { minify: true } });
    const { exports } = compiler.stylesheet({
      code: '.a { --x: 1; } .b { width: var(--x); } .c { color: var(--other); }',
      lang: 'css',
      file: '/app/a.css',
    });
    assert.equal(exports.length, 3);
    const { code } = compiler.css();
    assert.doesNotMatch(code, /--x/);
    const [, name] = /(--\w+):1/.exec(code)!;
    assert.ok(code.includes(`width:var(${name})`), code);
    assert.match(code, /color:var\(--other\)/);
  });

  test('two files keep separate names', async () => {
    const compiler = await createCompiler({ ...on, lightningcss: { minify: true } });
    for (const file of ['/app/a.css', '/app/b.css'])
      compiler.stylesheet({ code: '.a { --x: 1; }', lang: 'css', file });
    assert.equal(compiler.css().code.match(/--\w+:1/g)!.length, 2);
  });
});

describe('libraries', () => {
  test("a library's setting applies to its files, and the app's to its own", async () => {
    const compiler = await createCompiler({
      customPropertyLocalization: false,
      libraries: [{ dir: '/lib', customPropertyLocalization: true }],
      lightningcss: { minify: true },
    });
    compiler.classString({ code: '--app: 1;', lang: 'css', file: '/app/a.ts' });
    compiler.classString({ code: '--lib: 1;', lang: 'css', file: '/lib/a.ts' });
    const { code } = compiler.css();
    assert.match(code, /--app:1/);
    assert.doesNotMatch(code, /--lib/);
  });
});
