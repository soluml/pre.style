import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler, createCompiler, PreStyleError } from '../../src/compiler/index.ts';
import { compile, css } from './helpers.ts';

// Class names depend on how often each entry is used across all blocks.
// Ties are broken by each entry's key, so the letters in these tests are
// stable but not always in reading order.

describe('spec examples', () => {
  test('flat declarations and a selector variant', async () => {
    const { classes, css: output } = await compile([`color: blue; & > * { color: green; }`]);
    assert.deepEqual(classes, ['B A']);
    assert.equal(
      output,
      css`
        .B{color:#00f}
        .A>*{color:green}
      `,
    );
  });

  test('an atomic at-rule', async () => {
    const { classes, css: output } = await compile([
      `color: black; @media (min-width: 768px) and (prefers-color-scheme: dark) { background-color: red; }`,
    ]);
    assert.deepEqual(classes, ['A B']);
    assert.equal(
      output,
      css`
        .A{color:#000}
        @media (width>=768px) and (prefers-color-scheme:dark) {
          .B{background-color:red}
        }
      `,
    );
  });

  test('classes under the same at-rule share one group', async () => {
    const { classes, css: output } = await compile([
      `color: yellow; @media (min-width: 768px) { background-color: green; }`,
      `color: orange; @media (min-width: 768px) { background-color: purple; }`,
    ]);
    assert.deepEqual(classes, ['B C', 'A D']);
    assert.equal(
      output,
      css`
        .B{color:#ff0}
        .A{color:orange}
        @media (width>=768px) {
          .C{background-color:green}
          .D{background-color:purple}
        }
      `,
    );
  });

  test('shorthand expansion', async () => {
    const { classes, css: output } = await compile([
      `margin: auto; padding: var(--gap); padding-top: 0;`,
    ]);
    assert.deepEqual(classes, ['D C A B F E']);
    // `padding: var(--gap)` can't be expanded, so it comes first and
    // `padding-top: 0` wins.
    assert.equal(
      output,
      css`
        .F{padding:var(--gap)}
        .D{margin-top:auto}
        .C{margin-right:auto}
        .A{margin-bottom:auto}
        .B{margin-left:auto}
        .E{padding-top:0}
      `,
    );
  });
});

describe('names', () => {
  test('the most-used entries get the shortest names', async () => {
    const { classes } = await compile([
      `color: red; margin-top: 0`,
      `color: red`,
      `color: red; padding-top: 0`,
      `padding-top: 0`,
    ]);
    // `color: red` is used 3 times, `padding-top: 0` twice, `margin-top: 0` once.
    assert.deepEqual(classes, ['A C', 'A', 'A B', 'B']);
  });

  test('equal declarations share a class, however they are written', async () => {
    const { classes, css: output } = await compile([
      `color: blue`,
      `color: #00f`,
      `color: rgb(0 0 255)`,
    ]);
    assert.deepEqual(classes, ['A', 'A', 'A']);
    assert.equal(output, '.A{color:#00f}');
  });

  test('equivalent nestings produce the same class', async () => {
    const { classes, css: output } = await compile([
      `@media (min-width: 1px) { &:hover { color: red } }`,
      `&:hover { @media (min-width: 1px) { color: red } }`,
    ]);
    assert.deepEqual(classes, ['A', 'A']);
    assert.equal(
      output,
      css`
        @media (width>=1px) {
          .A:hover{color:red}
        }
      `,
    );
  });

  test('nested at-rules are written from outermost to innermost', async () => {
    const { classes, css: output } = await compile([
      `@supports (display: grid) { @media (min-width: 768px) { display: grid } }`,
    ]);
    assert.deepEqual(classes, ['A']);
    assert.equal(
      output,
      css`
        @supports (display:grid) {
          @media (width>=768px) {
            .A{display:grid}
          }
        }
      `,
    );
  });

  test('!important declarations get their own class', async () => {
    const { classes, css: output } = await compile([`color: red !important`, `color: red`]);
    assert.deepEqual(classes, ['B', 'A']);
    assert.equal(
      output,
      css`
        .B{color:red!important}
        .A{color:red}
      `,
    );
  });

  test('custom properties become atomic classes', async () => {
    const { classes, css: output } = await compile([`--gap: 4px; gap: var(--gap)`]);
    assert.deepEqual(classes, ['A B']);
    // `gap: var(--gap)` is a shorthand that couldn't be expanded, so it
    // comes first.
    assert.equal(
      output,
      css`
        .B{gap:var(--gap)}
        .A{--gap:4px}
      `,
    );
  });

  test('names are ASCII CSS identifiers, even after the two-character ones run out', async () => {
    const compiler = await createCompiler();
    const names = Array.from({ length: 3600 }, (_, i) =>
      compiler.classString({ code: `width: ${i}px`, lang: 'css' }),
    );
    for (const name of names) assert.match(name, /^(?!-?[0-9]|--|-$)[-_A-Za-z0-9]+$/);
    assert.deepEqual(names.slice(0, 3), ['A', 'B', 'C']);
    assert.equal(names[52], '_');
    assert.equal(names[3498], 'A00');
  });

  test('quirksMode leaves uppercase letters out of class names', async () => {
    const compiler = await createCompiler({ quirksMode: true });
    const names = Array.from({ length: 1200 }, (_, i) =>
      compiler.classString({ code: `width: ${i}px`, lang: 'css' }),
    );
    for (const name of names) assert.match(name, /^(?!-?[0-9]|--|-$)[-_a-z0-9]+$/);
    assert.deepEqual(names.slice(0, 3), ['a', 'b', 'c']);
    assert.equal(names[26], '_');
    assert.equal(names[27].length, 2);
  });

  test('dev mode names blocks on demand, without a scan', async () => {
    const compiler = await createCompiler({ lightningcss: { minify: true } });
    assert.equal(compiler.classString({ code: 'margin-top: 0', lang: 'css' }), 'A');
    assert.equal(compiler.classString({ code: 'color: red; margin-top: 0', lang: 'css' }), 'B A');
    assert.equal(compiler.css().code, '.A{margin-top:0}.B{color:red}');
  });
});

describe('selector variants', () => {
  test('complex selectors become selector variants', async () => {
    const { classes, css: output } = await compile([
      `.dark & { color: white } a { color: red } & > *, &:hover { color: green } &.active:hover { color: blue } &:hover { & > span { color: pink } }`,
    ]);
    assert.deepEqual(classes, ['A D C B E']);
    assert.equal(
      output,
      css`
        .dark .A{color:#fff}
        .D a{color:red}
        .C>*,.C:hover{color:green}
        .B.active:hover{color:#00f}
        .E:hover>span{color:pink}
      `,
    );
  });
});

describe('output order', () => {
  test('base classes, then selector variants in LVHFA order', async () => {
    const { css: output } = await compile([
      `&:active { color: red } &:focus { color: red } &:hover { color: red } &:visited { color: red } &:link { color: red } &::before { content: 'x' } color: red`,
    ]);
    // Lightning CSS's minifier merges the adjacent rules with the same
    // declarations, keeping their order.
    assert.equal(
      output,
      css`
        .G{color:red}
        .F:before{content:"x"}
        .D:link,.E:visited,.C:hover,.B:focus,.A:active{color:red}
      `,
    );
  });

  test('@media min-width queries come last, smallest first', async () => {
    const { css: output } = await compile([
      `@media (min-width: 1024px) { color: red } @media print { color: red } @media (min-width: 40em) { color: red } @media (max-width: 100px) { color: red } @media (min-width: 320px) { color: red }`,
    ]);
    assert.equal(
      output,
      css`
        @media print {
          .E{color:red}
        }
        @media (width<=100px) {
          .D{color:red}
        }
        @media (width>=320px) {
          .C{color:red}
        }
        @media (width>=40em) {
          .A{color:red}
        }
        @media (width>=1024px) {
          .B{color:red}
        }
      `,
    );
  });

  test('hoisted at-rules come first, in hoist order', async () => {
    const { css: output } = await compile([
      `@font-face { font-family: x; src: url(x.woff2) } @namespace svg url(http://www.w3.org/2000/svg); @import url(a.css); @layer base, components; color: red`,
    ]);
    assert.equal(
      output,
      css`
        @layer base,components;
        @import "a.css";
        @namespace svg "http://www.w3.org/2000/svg";
        @font-face{font-family:x;src:url(x.woff2)}
        .A{color:red}
      `,
    );
  });
});

// Browsers without `svh` and `oklch()`.
const OLD_TARGETS = { chrome: 100 << 16, safari: 14 << 16 };

describe('declarations in a block', () => {
  test('later declarations override earlier ones', async () => {
    const { classes, css: output } = await compile([
      `color: red; color: blue; margin-top: 1px; margin: 0;`,
    ]);
    assert.deepEqual(classes, ['A E D B C']);
    assert.equal(
      output,
      css`
        .A{color:#00f}
        .E{margin-top:0}
        .D{margin-right:0}
        .B{margin-bottom:0}
        .C{margin-left:0}
      `,
    );
  });

  test('!important declarations win', async () => {
    const { classes, css: output } = await compile([`color: red !important; color: blue`]);
    assert.deepEqual(classes, ['A']);
    assert.equal(output, '.A{color:red!important}');
  });

  test('declarations of the same property are kept as fallbacks', async () => {
    // Targets without `svh`, so Lightning CSS keeps the fallback.
    const { classes, css: output } = await compile([`height: 100%; width: 1px; height: 100svh;`], {
      lightningcss: { targets: OLD_TARGETS },
    });
    assert.deepEqual(classes, ['B A']);
    assert.equal(
      output,
      css`
        .B{width:1px}
        .A{height:100%;height:100svh}
      `,
    );
  });

  test('fallbacks the targets support are dropped, so the class is shared', async () => {
    const { classes, css: output } = await compile([
      `height: 100%; height: 100svh;`,
      `height: 100svh;`,
    ]);
    assert.deepEqual(classes, ['A', 'A']);
    assert.equal(output, '.A{height:100svh}');
  });

  test("fallbacks for values Lightning CSS can't parse are kept", async () => {
    const { css: output } = await compile([
      `width: 100px; width: calc-size(auto, round(down, size, 1rem));`,
    ]);
    assert.equal(output, '.A{width:100px;width:calc-size(auto, round(down, size, 1rem))}');
  });

  test('!important fallbacks are kept', async () => {
    const { css: output } = await compile([`height: 100% !important; height: 100svh !important;`], {
      lightningcss: { targets: OLD_TARGETS },
    });
    assert.equal(output, '.A{height:100%!important;height:100svh!important}');
  });

  test('a declaration in another rule overrides instead', async () => {
    const { css: output } = await compile([`height: 100%; & { height: 100svh; }`], {
      lightningcss: { targets: OLD_TARGETS },
    });
    assert.equal(output, '.A{height:100svh}');
  });

  test('a declaration that always parses replaces earlier ones', async () => {
    // `var()` and `env()` are checked only when substituted, so a browser
    // never falls back from them.
    const { css: output } = await compile(
      [`height: 100%; height: var(--x); padding-top: 1px; padding-top: env(safe-area-inset-top);`],
      { lightningcss: { targets: OLD_TARGETS } },
    );
    assert.equal(
      output,
      css`
        .A{height:var(--x)}
        .B{padding-top:env(safe-area-inset-top)}
      `,
    );
  });

  test('border stays one class', async () => {
    // Written before longhands, so `border-top-color` still wins.
    const { classes, css: output } = await compile([
      `border: 1px solid red; border-top-color: blue`,
    ]);
    assert.deepEqual(classes, ['A B']);
    assert.equal(
      output,
      css`
        .A{border:1px solid red}
        .B{border-top-color:#00f}
      `,
    );
  });

  test('shorthands with CSS-wide keywords stay one class', async () => {
    // Written before longhands, so `font-weight: 600` still wins.
    const { classes, css: output } = await compile([`font: inherit; font-weight: 600`]);
    assert.deepEqual(classes, ['B A']);
    assert.equal(
      output,
      css`
        .B{font:inherit}
        .A{font-weight:600}
      `,
    );
  });

  test('a later shorthand with a CSS-wide keyword overrides earlier longhands', async () => {
    const { classes, css: output } = await compile([`font-weight: 600; font: inherit`]);
    assert.deepEqual(classes, ['A']);
    assert.equal(output, '.A{font:inherit}');
  });
});

describe('global rules', () => {
  test('identical rules from several blocks are written once', async () => {
    const { classes, css: output } = await compile([
      `@keyframes spin { to { rotate: 1turn } } animation-name: spin`,
      `@keyframes spin { to { rotate: 1turn } } color: red`,
    ]);
    assert.deepEqual(classes, ['A', 'B']);
    assert.equal(
      output,
      css`
        @keyframes spin {
          to{rotate:1turn}
        }
        .A{animation-name:spin}
        .B{color:red}
      `,
    );
  });

  test('only the last definition of an overridable at-rule is kept', async () => {
    const { classes, css: output } = await compile([
      `@keyframes spin { to { rotate: 1turn } }`,
      `@keyframes spin { to { rotate: -1turn } }`,
    ]);
    assert.deepEqual(classes, ['', '']);
    assert.equal(
      output,
      css`
        @keyframes spin {
          to{rotate:-1turn}
        }
      `,
    );
  });

  test("`@-webkit-keyframes` doesn't replace `@keyframes` with the same name", async () => {
    const { css: output } = await compile([
      `@keyframes spin { to { rotate: 1turn } } @-webkit-keyframes spin { to { rotate: 1turn } }`,
    ]);
    // Lightning CSS writes the prefixed rule first.
    assert.equal(
      output,
      css`
        @-webkit-keyframes spin {
          to{rotate:1turn}
        }
        @keyframes spin {
          to{rotate:1turn}
        }
      `,
    );
  });
});

describe('keyframeLocalization option', () => {
  const options = { keyframeLocalization: true };

  test("each block's keyframes get a generated name, used in its own declarations", async () => {
    const { classes, css: output } = await compile(
      [
        `@keyframes spin { to { rotate: 1turn } } animation-name: spin`,
        `@keyframes spin { to { rotate: -1turn } } animation-name: spin`,
      ],
      options,
    );
    assert.deepEqual(classes, ['B', 'A']);
    assert.equal(
      output,
      css`
        @keyframes B {
          to{rotate:1turn}
        }
        @keyframes A {
          to{rotate:-1turn}
        }
        .B{animation-name:B}
        .A{animation-name:A}
      `,
    );
  });

  test('identical keyframes share one name, whatever they were called', async () => {
    const { classes, css: output } = await compile(
      [
        `@keyframes spin { to { rotate: 1turn } } animation-name: spin`,
        `@keyframes turn { to { rotate: 1turn } } animation-name: turn; color: red`,
      ],
      options,
    );
    assert.deepEqual(classes, ['A', 'A B']);
    assert.equal(
      output,
      css`
        @keyframes A {
          to{rotate:1turn}
        }
        .A{animation-name:A}
        .B{color:red}
      `,
    );
  });

  test("names a block doesn't define are left as they are", async () => {
    const { css: output } = await compile(
      [`@keyframes spin { to { rotate: 1turn } }`, `animation-name: spin, fade`],
      options,
    );
    assert.equal(
      output,
      css`
        @keyframes A {
          to{rotate:1turn}
        }
        .A{animation-name:spin,fade}
      `,
    );
  });

  test('shorthands, strings, var(), selector variants, and vendor prefixes are renamed', async () => {
    const { css: output } = await compile(
      [
        `@keyframes spin { to { rotate: 1turn } }
        @-webkit-keyframes spin { to { rotate: 1turn } }
        animation: var(--duration) spin;
        -webkit-animation-name: spin;
        &:hover { animation-name: "spin", other }`,
      ],
      options,
    );
    assert.equal(
      output,
      css`
        @-webkit-keyframes A {
          to{rotate:1turn}
        }
        @keyframes A {
          to{rotate:1turn}
        }
        .C{animation:var(--duration) A}
        .B{-webkit-animation-name:A}
        .A:hover{animation-name:A,other}
      `,
    );
  });

  test('scss blocks are localized after Sass compiles them', async () => {
    const { css: output } = await compile(
      [
        {
          code: `$name: spin; @keyframes #{$name} { to { rotate: 1turn } } animation-name: $name`,
          lang: 'scss',
        },
      ],
      options,
    );
    assert.equal(
      output,
      css`
        @keyframes A {
          to{rotate:1turn}
        }
        .A{animation-name:A}
      `,
    );
  });

  test('keyframes from prepended files are written once and shared by every block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre.style-'));
    writeFileSync(join(dir, 'motion.css'), '@keyframes fade { from { opacity: 0 } }');
    const { classes, css: output } = await compile(
      [`animation-name: fade`, `animation-name: fade; color: red`],
      { ...options, root: dir, prependFiles: ['motion.css'] },
    );
    assert.deepEqual(classes, ['A', 'A B']);
    assert.equal(
      output,
      css`
        @keyframes A {
          0%{opacity:0}
        }
        .A{animation-name:A}
        .B{color:red}
      `,
    );
  });

  test("libraries use their own setting, not the app's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre.style-'));
    const block = `@keyframes spin { to { rotate: 1turn } } animation-name: spin`;
    const blocks = [
      { code: block, lang: 'css' as const, file: join(dir, 'src', 'App.tsx') },
      { code: block, lang: 'css' as const, file: join(dir, 'lib', 'Spinner.js') },
      { code: block, lang: 'css' as const, file: join(dir, 'local', 'Spinner.js') },
    ];
    const { css: output } = await compile(blocks, {
      root: dir,
      keyframeLocalization: true,
      libraries: [{ dir: 'lib' }, { dir: 'local', keyframeLocalization: true }],
    });
    // The app and the library that opts in share one localized copy; the
    // other library keeps the global name.
    assert.equal(
      output,
      css`
        @keyframes A {
          to{rotate:1turn}
        }
        @keyframes spin {
          to{rotate:1turn}
        }
        .A{animation-name:A}
        .B{animation-name:spin}
      `,
    );
  });
});

describe('scss blocks', () => {
  test('compile with Sass first', async () => {
    const { classes, css: output } = await compile([
      {
        code: `$c: red; color: $c; &:hover { color: #c00 } @media (min-width: 1px) { margin-top: 0 }`,
        lang: 'scss',
      },
    ]);
    assert.deepEqual(classes, ['B A C']);
    assert.equal(
      output,
      css`
        .B{color:red}
        .A:hover{color:#c00}
        @media (width>=1px) {
          .C{margin-top:0}
        }
      `,
    );
  });

  test('Sass warnings go to the warn option', async () => {
    const warnings: string[] = [];
    await compile([{ code: '@warn "careful"; color: red', lang: 'scss' }], {
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(warnings, ['careful']);
  });
});

describe('prependFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre.style-'));
  writeFileSync(join(dir, 'vars.css'), ':root { --gap: 4px }');
  writeFileSync(join(dir, 'vars.scss'), '$brand: red; @mixin hover { &:hover { @content; } }');

  test('an array applies to every block', async () => {
    const { css: output } = await compile(
      [`gap: var(--gap)`, { code: `margin-top: 0`, lang: 'scss' }],
      { root: dir, prependFiles: ['vars.css'] },
    );
    // The rule from the prepended file is written once.
    assert.equal(
      output,
      css`
        :root{--gap:4px}
        .B{gap:var(--gap)}
        .A{margin-top:0}
      `,
    );
  });

  test('an object applies css files to css blocks and scss files to scss blocks', async () => {
    const { classes, css: output } = await compile(
      [`gap: var(--gap)`, { code: `color: $brand; @include hover { color: blue }`, lang: 'scss' }],
      { root: dir, prependFiles: { css: ['vars.css'], scss: ['vars.scss'] } },
    );
    assert.deepEqual(classes, ['C', 'B A']);
    assert.equal(
      output,
      css`
        :root{--gap:4px}
        .C{gap:var(--gap)}
        .B{color:red}
        .A:hover{color:#00f}
      `,
    );
  });
});

describe('libraries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre.style-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'app.scss'), '$space: 1rem;');
  writeFileSync(join(dir, 'lib', 'tokens.scss'), '$space: 4px;');
  const options = {
    root: dir,
    prependFiles: { scss: ['app.scss'] },
    libraries: [{ dir: 'lib', prependFiles: { scss: ['tokens.scss'] } }],
  };

  test("a library's blocks get only its prepended files", async () => {
    const { classes, css: output } = await compile(
      [
        { code: 'margin-top: $space;', lang: 'scss', file: join(dir, 'src', 'App.tsx') },
        { code: 'margin-top: $space;', lang: 'scss', file: join(dir, 'lib', 'Button.js') },
      ],
      options,
    );
    // The same block compiles differently in the app and the library.
    assert.deepEqual(classes, ['B', 'A']);
    assert.equal(
      output,
      css`
        .B{margin-top:1rem}
        .A{margin-top:4px}
      `,
    );
  });

  test("the app's prepended files don't apply to a library's blocks", async () => {
    writeFileSync(join(dir, 'app.scss'), '$space: 1rem; $only-app: red;');
    await assert.rejects(
      compile(
        [{ code: 'color: $only-app;', lang: 'scss', file: join(dir, 'lib', 'Button.js') }],
        options,
      ),
      /Undefined variable/,
    );
  });
});

describe('lightningcss option', () => {
  test("the user's visitor runs before pre.style atomizes", async () => {
    const { css: output } = await compile([`margin-top: 1px`], {
      lightningcss: { visitor: { Length: (length) => ({ ...length, value: length.value * 2 }) } },
    });
    assert.equal(output, '.A{margin-top:2px}');
  });

  test('options apply when writing the output', async () => {
    const compiler = await createCompiler({ lightningcss: { minify: false } });
    compiler.classString({ code: 'color: red', lang: 'css' });
    assert.equal(compiler.css().code, '.A {\n  color: red;\n}\n');
  });
});

describe('sourceMap option', () => {
  test('maps each class to the first block it appears in', async () => {
    const compiler = await createCompiler({ sourceMap: true, lightningcss: { minify: true } });
    compiler.classString({
      code: '\n  color: red;\n  &:hover { color: blue }',
      lang: 'css',
      file: '/src/A.tsx',
      line: 5,
      column: 18,
    });
    compiler.classString({
      code: 'color: red',
      lang: 'css',
      file: '/src/B.tsx',
      line: 2,
      column: 9,
    });
    const { code, map } = compiler.css();
    assert.equal(code, '.A{color:red}.B:hover{color:#00f}');
    const json = JSON.parse(map!);
    assert.deepEqual(json.sources, ['/src/A.tsx']);
    // `.A` maps to line 5, column 18 (A.tsx's first block), and `.B:hover`
    // to line 7, column 3.
    assert.equal(json.mappings, 'AAIiB,aAEf');
  });

  test('is off by default', async () => {
    const compiler = await createCompiler();
    compiler.classString({ code: 'color: red', lang: 'css' });
    assert.equal(compiler.css().map, null);
  });
});

const blockIn = (file: string, line: number, code: string) => ({
  code,
  lang: 'css' as const,
  file,
  line,
  column: 9,
});

describe('usages', () => {
  test('lists every place a class is used, once each', async () => {
    const compiler = await createCompiler({ sourceMap: true });
    const a = blockIn('/src/A.tsx', 5, 'color: red');
    compiler.classString(a);
    compiler.classString(a);
    compiler.classString(blockIn('/src/B.tsx', 2, 'color: red'));
    compiler.css();
    assert.deepEqual(compiler.usages(['A']), [
      {
        className: 'A',
        selector: '.A',
        atRules: [],
        declaration: 'color: red',
        property: 'color',
        covers: [],
        important: false,
        specificity: [0, 1, 0],
        order: 1,
        sources: [
          { file: '/src/A.tsx', line: 5, column: 9 },
          { file: '/src/B.tsx', line: 2, column: 9 },
        ],
      },
    ]);
  });

  test('lists every fallback in a stack', async () => {
    // Printed without the targets, which would drop the fallback.
    const compiler = await createCompiler({
      sourceMap: true,
      lightningcss: { targets: OLD_TARGETS },
    });
    const names = compiler
      .classString(blockIn('/src/A.tsx', 1, 'height: 100%; height: 100svh'))
      .split(' ');
    compiler.css();
    assert.deepEqual(
      compiler.usages(names).map((usage) => usage.declaration),
      ['height: 100%; height: 100svh'],
    );
  });

  test('describes selectors, at-rules, and shorthands', async () => {
    const compiler = await createCompiler({
      sourceMap: true,
      lightningcss: { minify: true },
    });
    const names = compiler
      .classString(
        blockIn(
          '/src/A.tsx',
          1,
          `@media (min-width: 768px) { @supports (display: grid) { .dark &:hover { color: red !important } } }
           border: 1px solid var(--c);`,
        ),
      )
      .split(' ');
    compiler.css();
    const usages = compiler.usages(names);
    const border = usages.find((usage) => usage.property === 'border')!;
    assert.equal(border.declaration, 'border: 1px solid var(--c)');
    assert.ok(border.covers.includes('border-top-color'));
    const color = usages.find((usage) => usage.property === 'color')!;
    assert.deepEqual(color.atRules, ['@media (width >= 768px)', '@supports (display: grid)']);
    assert.equal(color.selector, `.dark .${color.className}:hover`);
    assert.equal(color.declaration, 'color: red !important');
    assert.equal(color.important, true);
    assert.deepEqual(color.specificity, [0, 3, 0]);
    assert.ok(color.order > border.order);
  });

  test('counts specificity through :is, :where, and pseudo-elements', async () => {
    const compiler = await createCompiler();
    const names = compiler
      .classString({
        code: `:is(#a, .b) &::before { color: red } :where(#a) & { margin-top: 0 }`,
        lang: 'css',
      })
      .split(' ');
    compiler.css();
    const usages = compiler.usages(names);
    assert.deepEqual(usages.find((u) => u.property === 'color')!.specificity, [1, 1, 1]);
    assert.deepEqual(usages.find((u) => u.property === 'margin-top')!.specificity, [0, 1, 0]);
  });

  test('skips names that are not in the output', async () => {
    const compiler = await createCompiler();
    compiler.classString({ code: 'color: red', lang: 'css' });
    assert.deepEqual(compiler.usages(['nope']), []);
  });

  test('keeps only the first source when sourceMap is off', async () => {
    const compiler = await createCompiler();
    compiler.classString(blockIn('/src/A.tsx', 5, 'color: red'));
    compiler.css();
    assert.deepEqual(compiler.usages(['A'])[0].sources, []);
  });

  test('forgetSources drops a changed file until it compiles again', async () => {
    const compiler = await createCompiler({ sourceMap: true });
    compiler.classString(blockIn('/src/A.tsx', 5, 'color: red'));
    compiler.classString(blockIn('/src/B.tsx', 2, 'color: red'));
    compiler.css();
    compiler.forgetSources('/src/A.tsx');
    assert.deepEqual(
      compiler.usages(['A'])[0].sources.map((source) => source.file),
      ['/src/B.tsx'],
    );
    // The source map follows, to the first place it's still used.
    assert.deepEqual(JSON.parse(compiler.css().map!).sources, ['/src/B.tsx']);
    compiler.classString(blockIn('/src/A.tsx', 8, 'color: red'));
    assert.deepEqual(
      compiler.usages(['A'])[0].sources.map(({ file, line }) => `${file}:${line}`),
      ['/src/B.tsx:2', '/src/A.tsx:8'],
    );
  });

  test('stylesheet classes list their file', async () => {
    const compiler = await createCompiler({ sourceMap: true });
    const { exports } = compiler.stylesheet({
      code: '.button { color: red }',
      lang: 'css',
      file: '/src/button.css',
    });
    compiler.css();
    const [usage] = compiler.usages([exports[0][1]]);
    assert.equal(usage.sources[0].file, '/src/button.css');
  });
});

describe('layer option', () => {
  test('wraps the output in a named layer, with @import outside it', async () => {
    const compiler = await createCompiler({ layer: 'pre.style' });
    compiler.classString({
      code: `@import url(reset.css); @layer base, theme; color: red; @layer theme { margin-top: 0 }`,
      lang: 'css',
    });
    // `@layer` statements and `@layer` rules from blocks are nested in it.
    // Lightning CSS merges the statement into the `@layer theme` rule, and
    // writes `.A` after it, which doesn't change the cascade: styles directly
    // in a layer win over its nested layers.
    assert.equal(
      compiler.css().code,
      [
        '@import "reset.css";',
        '',
        '@layer pre.style {',
        '  @layer base;',
        '',
        '  @layer theme {',
        '    .B {',
        '      margin-top: 0;',
        '    }',
        '  }',
        '',
        '  .A {',
        '    color: red;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('an empty string wraps the output in an unnamed layer', async () => {
    const { css: output } = await compile([`color: red`], { layer: '' });
    assert.equal(
      output,
      css`
        @layer {
          .A{color:red}
        }
      `,
    );
  });

  test('dotted names are nested layers', async () => {
    const { css: output } = await compile([`color: red`], { layer: 'vendor.pre-style' });
    assert.equal(
      output,
      css`
        @layer vendor.pre-style {
          .A{color:red}
        }
      `,
    );
  });

  test('is off by default, and with false', async () => {
    assert.equal((await compile([`color: red`])).css, '.A{color:red}');
    assert.equal((await compile([`color: red`], { layer: false })).css, '.A{color:red}');
  });

  test('fails on names that are not a layer name', async () => {
    for (const layer of ['a b', 'a, b', '1x', 'a {} .b']) {
      await assert.rejects(
        createCompiler({ layer }),
        (error: unknown) =>
          error instanceof PreStyleError &&
          error.message.startsWith('`layer` must be a layer name'),
      );
    }
  });

  test('source maps still map each class to its block', async () => {
    const compiler = await createCompiler({
      sourceMap: true,
      layer: 'app',
      lightningcss: { minify: true },
    });
    compiler.classString({
      code: 'color: red',
      lang: 'css',
      file: '/src/A.tsx',
      line: 3,
      column: 9,
    });
    const { code, map } = compiler.css();
    assert.equal(code, '@layer app{.A{color:red}}');
    const json = JSON.parse(map!);
    assert.deepEqual(json.sources, ['/src/A.tsx']);
    // `.A` (column 11) maps to line 3, column 9.
    assert.equal(json.mappings, 'AAAA,WAEQ');
  });
});

describe('errors', () => {
  test('invalid CSS fails with the file, line, and column', async () => {
    const compiler = await createCompiler();
    assert.throws(
      () =>
        compiler.classString({
          code: 'color: red;\n  & > { }}',
          lang: 'css',
          file: 'src/App.tsx',
          line: 10,
          column: 20,
        }),
      (error: unknown) =>
        error instanceof PreStyleError && error.message.startsWith('src/App.tsx:11:7: Invalid CSS'),
    );
  });

  test('Sass errors fail with the file, line, and column', async () => {
    const compiler = await createCompiler();
    assert.throws(
      () =>
        compiler.classString({
          code: 'color: $nope;',
          lang: 'scss',
          file: 'src/App.tsx',
          line: 10,
          column: 20,
        }),
      (error: unknown) =>
        error instanceof PreStyleError &&
        error.message.startsWith(
          'src/App.tsx:10:27: Sass failed to compile the block: Undefined variable.',
        ),
    );
  });

  test('scss blocks fail when Sass is not installed', () => {
    const compiler = new Compiler({}, null);
    assert.throws(
      () => compiler.classString({ code: 'color: red', lang: 'scss' }),
      /Install the `sass` package/,
    );
  });
});
