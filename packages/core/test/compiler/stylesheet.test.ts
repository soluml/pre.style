import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCompiler, PreStyleError } from '../../src/compiler/index.ts';
import type { CompilerOptions, Lang } from '../../src/compiler/index.ts';
import { css, format } from './helpers.ts';

// Writes files to a new directory, and returns it.
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pre-style-'));
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), code);
  }
  return dir;
}

// Compiles a stylesheet the way a production build does, and returns its
// exports and the output CSS, minified, with one rule per line.
async function compileSheet(
  code: string,
  {
    lang = 'css',
    files = {},
    options = {},
  }: { lang?: Lang; files?: Record<string, string>; options?: CompilerOptions } = {},
) {
  const root = project(files);
  const compiler = await createCompiler({
    root,
    ...options,
    lightningcss: { minify: true, ...options.lightningcss },
  });
  const sheet = { code, lang, file: join(root, `styles.${lang}`) };
  compiler.scanStylesheet(sheet);
  compiler.assignNames();
  const { exports, dependencies } = compiler.stylesheet(sheet);
  return {
    exports: Object.fromEntries(exports),
    names: exports.map(([name]) => name),
    dependencies: dependencies.map((file) => file.slice(root.length + 1)),
    css: format(compiler.css().code),
    root,
    compiler,
  };
}

describe('stylesheet files', () => {
  test('each class becomes a block, with the class as the element', async () => {
    const { exports, css: output } = await compileSheet(`
      .button { color: red; &:hover { color: blue; } }
      @media (min-width: 768px) { .button { color: green; } }
      .button { color: black; }
    `);
    // A later rule for the class overrides an earlier one, as in a block.
    assert.deepEqual(exports, { button: 'A C B' });
    assert.equal(
      output,
      css`
        .B{color:#000}
        .A:hover{color:#00f}
        @media (width>=768px) {
          .C{color:green}
        }
      `,
    );
  });

  test('declarations of the same property are kept as fallbacks', async () => {
    const { css: output } = await compileSheet(`.box { height: 100%; height: 100svh; }`, {
      options: { lightningcss: { targets: { chrome: 100 << 16, safari: 14 << 16 } } },
    });
    assert.equal(output, '.A{height:100%;height:100svh}');
  });

  test('classes are exported in the order they first appear', async () => {
    const { names } = await compileSheet(
      `.b { color: red; } .a { color: blue; } .b:hover { color: green; }`,
    );
    assert.deepEqual(names, ['b', 'a']);
  });

  test('a selector list applies the declarations to each class', async () => {
    const { exports } = await compileSheet(`.a, .b { color: red; } .b { padding-top: 0; }`);
    assert.deepEqual(exports, { a: 'A', b: 'A B' });
  });

  test('an empty class is exported as an empty string', async () => {
    const { exports } = await compileSheet(`.empty {}`);
    assert.deepEqual(exports, { empty: '' });
  });

  test('a selector belongs to the first class in its rightmost compound with one', async () => {
    const { exports, css: output } = await compileSheet(`
      .list > li { color: red; }
      .list li:hover { color: blue; }
      div.box { color: green; }
    `);
    assert.deepEqual(exports, { list: 'A B', box: 'C' });
    assert.equal(
      output,
      css`
        .A>li{color:red}
        div.C{color:green}
        .B li:hover{color:#00f}
      `,
    );
  });

  test('classes used as context for another class get a marker', async () => {
    const { exports, css: output } = await compileSheet(`
      .card { padding-top: 1rem; }
      .title { color: black; }
      .card:hover .title { color: red; }
    `);
    // `A` is `card`'s marker.
    assert.deepEqual(exports, { card: 'D A', title: 'C B' });
    assert.equal(
      output,
      css`
        .D{padding-top:1rem}
        .C{color:#000}
        .A:hover .B{color:red}
      `,
    );
  });

  test('classes that are not exported are written as they are', async () => {
    const { exports, css: output } = await compileSheet(`
      .button { color: black; }
      .dark .button { color: white; }
      .button:not(.active) { opacity: 0.5; }
    `);
    assert.deepEqual(exports, { button: 'C A B' });
    assert.equal(
      output,
      css`
        .C{color:#000}
        .dark .A{color:#fff}
        .B:not(.active){opacity:.5}
      `,
    );
  });

  test('in a compound, the first class owns the declarations and the others get markers', async () => {
    const { exports, css: output } = await compileSheet(`.a.b { color: pink; } .b { color: red; }`);
    assert.deepEqual(exports, { a: 'B', b: 'C A' });
    assert.equal(
      output,
      css`
        .C{color:red}
        .B.A{color:pink}
      `,
    );
  });

  test('markers replace exported classes in pseudo-class arguments and global rules', async () => {
    const { exports, css: output } = await compileSheet(`
      .open { color: red; }
      .menu:has(.open) { color: blue; }
      body:has(.open) { overflow: hidden; }
    `);
    assert.deepEqual(exports, { open: 'C A', menu: 'B' });
    assert.equal(
      output,
      css`
        body:has(.A){overflow:hidden}
        .C{color:red}
        .B:has(.A){color:#00f}
      `,
    );
  });

  test("markers belong to their file, so two files' classes with the same name don't share one", async () => {
    const root = project({});
    const compiler = await createCompiler({ root, lightningcss: { minify: true } });
    const a = { code: '.a.x { color: red; }', lang: 'css' as const, file: join(root, 'a.css') };
    const b = { code: '.b.x { color: red; }', lang: 'css' as const, file: join(root, 'b.css') };
    compiler.scanStylesheet(a);
    compiler.scanStylesheet(b);
    compiler.assignNames();
    const x = (sheet: typeof a) => Object.fromEntries(compiler.stylesheet(sheet).exports).x;
    assert.notEqual(x(a), x(b));
  });

  test('rules without a class are global', async () => {
    const { exports, css: output } = await compileSheet(`
      @import url('reset.css');
      :root { --space: 4px; }
      @keyframes spin { to { rotate: 1turn; } }
      .spinner { animation-name: spin; }
      body > main { margin-top: 0; }
    `);
    assert.deepEqual(exports, { spinner: 'A' });
    assert.equal(
      output,
      css`
        @import "reset.css";
        :root{--space:4px}
        @keyframes spin {
          to{rotate:1turn}
        }
        body>main{margin-top:0}
        .A{animation-name:spin}
      `,
    );
  });

  test('scss files are compiled with Sass, and resolve relative loads from the file', async () => {
    const {
      exports,
      css: output,
      dependencies,
    } = await compileSheet(
      `
        @use 'tokens';
        @use 'sass:math';
        @each $size in (1, 2) {
          .p-#{$size} { padding-top: math.div($size, 2) * tokens.$space; }
        }
      `,
      { lang: 'scss', files: { '_tokens.scss': '$space: 8px;' } },
    );
    assert.deepEqual(exports, { 'p-1': 'A', 'p-2': 'B' });
    assert.equal(
      output,
      css`
        .A{padding-top:4px}
        .B{padding-top:8px}
      `,
    );
    assert.deepEqual(dependencies, ['_tokens.scss']);
  });
});

describe('prepended files in stylesheet files', () => {
  test("prepended rules are global, and their classes aren't exported", async () => {
    const { exports, css: output } = await compileSheet(`.a { color: var(--brand); }`, {
      files: { 'tokens.css': ':root { --brand: red; } .utility { display: none; }' },
      options: { prependFiles: { css: ['tokens.css'] } },
    });
    assert.deepEqual(exports, { a: 'A' });
    assert.equal(
      output,
      css`
        :root{--brand:red}
        .utility{display:none}
        .A{color:var(--brand)}
      `,
    );
  });

  test('scss files can use prepended variables and mixins, after their own @use rules', async () => {
    const { exports, css: output } = await compileSheet(
      `
        @use 'sass:math';
        .a { @include pad(math.div($space, 2)); }
        @include utility(hidden);
      `,
      {
        lang: 'scss',
        files: {
          'mixins.scss': css`
            $space: 8px;
            @mixin pad($size) { padding-top: $size; }
            @mixin utility($name) { .#{$name} { display: none; } }
            .global { color: red; }
          `,
        },
        options: { prependFiles: { scss: ['mixins.scss'] } },
      },
    );
    // Classes a prepended mixin writes into the file are the file's.
    assert.deepEqual(exports, { a: 'B', hidden: 'A' });
    assert.equal(
      output,
      css`
        .global{color:red}
        .B{padding-top:4px}
        .A{display:none}
      `,
    );
  });

  test("a prepended file compiled as a stylesheet isn't prepended to itself", async () => {
    // As TypeScript's content mapper does for every .scss file in a program,
    // including prepended ones. Prepended to itself, its `@use` would load
    // `sass:math` twice, which Sass rejects.
    const code = `
      @use 'sass:math';
      @mixin pad { padding-top: math.div($space, 2); }
      .a { @include pad; }
    `;
    const { exports, css: output } = await compileSheet(code, {
      lang: 'scss',
      files: { '_space.scss': '$space: 8px;', 'styles.scss': code },
      options: { prependFiles: { scss: ['_space.scss', 'styles.scss'] } },
    });
    // The other prepended file is still prepended.
    assert.deepEqual(exports, { a: 'A' });
    assert.equal(output, css`.A{padding-top:4px}`);
  });

  test('a css file prepended to itself keeps its classes, without global copies', async () => {
    const code = '.a { color: red; }';
    const { exports, css: output } = await compileSheet(code, {
      files: { 'styles.css': code },
      options: { prependFiles: { css: ['styles.css'] } },
    });
    assert.deepEqual(exports, { a: 'A' });
    assert.equal(output, css`.A{color:red}`);
  });
});

const fails = async (code: string, pattern: RegExp, files: Record<string, string> = {}) =>
  assert.rejects(compileSheet(code, { files }), (error: Error) => {
    assert.ok(error instanceof PreStyleError);
    assert.match(error.message, pattern);
    return true;
  });

describe('keyframeLocalization in stylesheet files', () => {
  test('keyframes are local to the file, and every class in it uses them', async () => {
    const { exports, css: output } = await compileSheet(
      `
        @keyframes spin { to { rotate: 1turn } }
        .spinner { animation: spin 1s linear infinite; }
        .icon:hover { animation-name: spin; }
        .other { animation-name: fade; }
      `,
      { options: { keyframeLocalization: true } },
    );
    assert.match(output, /^@keyframes A \{\n {2}to\{rotate:1turn\}\n\}/);
    assert.match(output, /\.[A-Za-z]+\{animation-name:A\}/);
    assert.match(output, /\.[A-Za-z]+:hover\{animation-name:A\}/);
    // `fade` isn't defined in the file, so it's left as it is.
    assert.match(output, /\.[A-Za-z]+\{animation-name:fade\}/);
    assert.doesNotMatch(output, /spin/);
    assert.deepEqual(Object.keys(exports), ['spinner', 'icon', 'other']);
  });

  test("a file's keyframes don't rename another file's", async () => {
    const root = project({});
    const compiler = await createCompiler({
      root,
      keyframeLocalization: true,
      lightningcss: { minify: true },
    });
    const a = {
      code: '@keyframes spin { to { rotate: 1turn } } .a { animation-name: spin; }',
      lang: 'css' as const,
      file: join(root, 'a.css'),
    };
    const b = {
      code: '@keyframes spin { to { rotate: -1turn } } .b { animation-name: spin; }',
      lang: 'css' as const,
      file: join(root, 'b.css'),
    };
    for (const sheet of [a, b]) compiler.scanStylesheet(sheet);
    compiler.assignNames();
    compiler.stylesheet(a);
    compiler.stylesheet(b);
    const output = format(compiler.css().code);
    // Two keyframes with different names, each used by its own file's class.
    const names = [...output.matchAll(/@keyframes (\w+)/g)].map((match) => match[1]);
    assert.equal(new Set(names).size, 2);
    for (const name of names) assert.match(output, new RegExp(`animation-name:${name}\\}`));
  });
});

describe('composes', () => {
  test('composes classes from the same file, with the class’s own declarations winning', async () => {
    const { exports } = await compileSheet(`
      .base { color: red; padding-top: 1rem; }
      .primary { composes: base; color: blue; }
    `);
    // `primary`'s `color: blue` replaces `base`'s `color: red`.
    assert.deepEqual(exports, { base: 'C A', primary: 'A B' });
  });

  test('composes classes from another file and global classes', async () => {
    const {
      exports,
      dependencies,
      css: output,
    } = await compileSheet(
      `.button { composes: base from './base.css'; composes: icon-btn from global; color: blue; }`,
      { files: { 'base.css': '.base { margin-top: 0; color: red; } :root { --unused: 1; }' } },
    );
    assert.deepEqual(exports, { button: 'B A icon-btn' });
    assert.deepEqual(dependencies, ['base.css']);
    // The composed file's rules are written too.
    assert.match(output, /:root\{--unused:1\}/);
  });

  test('composed classes keep their markers', async () => {
    const { exports } = await compileSheet(`
      .card { padding-top: 0; }
      .card:hover .title { color: red; }
      .featured { composes: card; }
    `);
    assert.equal(exports.featured, exports.card);
    assert.equal(exports.card.split(' ').length, 2);
  });

  test('blocks compose classes from stylesheet files', async () => {
    const root = project({ 'base.css': '.base { color: red; padding-top: 1rem; }' });
    const compiler = await createCompiler({ root, lightningcss: { minify: true } });
    const block = {
      code: 'composes: base from "./base.css"; composes: extra from global; color: blue;',
      lang: 'css' as const,
      file: join(root, 'main.ts'),
      line: 1,
      column: 1,
    };
    compiler.scan(block);
    compiler.assignNames();
    assert.equal(compiler.classString(block), 'B A extra');
    assert.deepEqual(compiler.dependencies(block), [join(root, 'base.css')]);
    assert.equal(
      format(compiler.css().code),
      css`
        .A{color:#00f}
        .C{color:red}
        .B{padding-top:1rem}
      `,
    );
  });

  test('scss blocks compose too', async () => {
    const root = project({ 'base.scss': '.base { color: red; }' });
    const compiler = await createCompiler({ root, lightningcss: { minify: true } });
    const block = {
      code: 'composes: base from "./base.scss"; margin-top: 0;',
      lang: 'scss' as const,
      file: join(root, 'main.ts'),
    };
    assert.equal(compiler.classString(block).split(' ').length, 2);
  });

  test('must come before the rule’s other declarations', async () => {
    await fails(`.a { color: red; } .b { color: red; composes: a; }`, /must come before/);
  });

  test("can't be used in nested selectors, at-rules, or with !important", async () => {
    await fails(`.a { color: red; } .b:hover { composes: a; }`, /must come before/);
    await fails(`.a { color: red; } .b { &:hover { composes: a; } }`, /must come before/);
    await fails(
      `.a { color: red; } @media (width > 1px) { .b { composes: a; } }`,
      /must come before/,
    );
    await fails(`.a { color: red; } .b { composes: a !important; }`, /can't be `!important`/);
  });

  test('fails on cycles, missing classes, and invalid values', async () => {
    await fails(
      `.a { composes: b; } .b { composes: a; }`,
      /`composes` cycle: .*styles\.css \.a -> .*styles\.css \.b -> .*styles\.css \.a/,
    );
    await fails(`.a { composes: missing; }`, /has no class `missing` to compose/);
    await fails(`.a { composes: x from './nope.css'; }`, /Can't read .*nope\.css/);
    await fails(`.a { composes: b from; }`, /Invalid `composes`/);
  });

  test('blocks fail when composing without from, or inside nested rules', async () => {
    const compiler = await createCompiler({ lightningcss: { minify: true } });
    assert.throws(
      () => compiler.classString({ code: 'composes: a;', lang: 'css', file: '/x/main.ts' }),
      /Blocks have no classes of their own/,
    );
    assert.throws(
      () =>
        compiler.classString({
          code: '&:hover { composes: a from global; }',
          lang: 'css',
          file: '/x/main.ts',
        }),
      /must come before/,
    );
  });
});

describe('errors in stylesheet files', () => {
  test('invalid CSS reports the file and position', async () => {
    const { root } = await compileSheet('.ok {}');
    const compiler = await createCompiler({ root });
    const file = join(root, 'bad.css');
    assert.throws(
      () => compiler.stylesheet({ code: '.a {\n  color: red;\n  & > { }}', lang: 'css', file }),
      (error: Error) => error.message.startsWith(`${file}:3:7: Invalid CSS`),
    );
  });

  test('Sass errors report the position in the file', async () => {
    const { root } = await compileSheet('.ok {}');
    const compiler = await createCompiler({ root, prependFiles: [] });
    const file = join(root, 'bad.scss');
    assert.throws(
      () => compiler.stylesheet({ code: '.a {\n  color: $missing;\n}', lang: 'scss', file }),
      (error: Error) =>
        error.message.startsWith(`${file}:2:`) && /Undefined variable/.test(error.message),
    );
  });
});
