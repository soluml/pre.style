import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  build,
  createLogger,
  createServer,
  defaultClientConditions,
  defaultServerConditions,
} from 'vite';
import { MagicString } from 'magic-string';
import type { EnvironmentModuleNode, InlineConfig, Plugin, Rollup } from 'vite';
import preStyle from '../src/index.ts';
import type { PreStyleOptions } from '../src/index.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const config = (name: string, options: PreStyleOptions): InlineConfig => ({
  root: fixture(name),
  logLevel: 'silent',
  // Resolve `@pre.style/core` to its TypeScript source, so tests don't need a build.
  resolve: { conditions: ['pre.style-source', ...defaultClientConditions] },
  build: { write: false, minify: false },
  plugins: [preStyle(options)],
});

// Builds a fixture without writing it, and returns its output files.
async function buildFixture(
  name: string,
  options: PreStyleOptions = {},
  overrides: InlineConfig = {},
) {
  const base = config(name, options);
  const result = (await build({
    ...base,
    ...overrides,
    build: { ...base.build, ...overrides.build },
  })) as Rollup.RollupOutput;
  const files = new Map<string, string>();
  for (const item of result.output)
    files.set(item.fileName, item.type === 'chunk' ? item.code : String(item.source));
  return files;
}

// Builds a fixture and returns the warnings logged.
async function warnings(name: string, options: PreStyleOptions = {}) {
  const logged: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => logged.push(message);
  const files = await buildFixture(name, options, { customLogger: logger });
  return { files, logged };
}

// Sets the `pre.style` field in a fixture's package.json while `run` runs.
async function withField<T>(name: string, field: unknown, run: () => Promise<T>): Promise<T> {
  const file = `${fixture(name)}/package.json`;
  const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const pkg =
    original === null
      ? { name: `fixture-${name}`, private: true, type: 'module' }
      : JSON.parse(original);
  writeFileSync(file, `${JSON.stringify({ ...pkg, 'pre.style': field }, null, 2)}\n`);
  try {
    return await run();
  } finally {
    if (original === null) rmSync(file);
    else writeFileSync(file, original);
  }
}

// The class string assigned to `button` in transformed code.
const classString = (code: string) => /button = "([^"]+)"/.exec(code)![1];

const chunk = (files: Map<string, string>) => [...files].find(([name]) => name.endsWith('.js'))![1];

describe('build', () => {
  test('replaces blocks and writes the CSS file', async () => {
    const files = await buildFixture('basic', { lightningcss: { minify: true } });
    assert.equal(
      files.get('pre.style.css'),
      '.P{padding-top:1rem}.N{padding-right:2rem}.J{padding-bottom:1rem}.L{padding-left:2rem}.A{color:red}' +
        '.O{padding-top:8px}.M{padding-right:8px}.I{padding-bottom:8px}.K{padding-left:8px}.D{font-size:2rem}' +
        '.H{margin-top:0}.G{margin-right:0}.E{margin-bottom:0}.F{margin-left:0}.C{color:green}.B:hover{color:#00f}' +
        '@media (width>=768px){.Q{font-size:3rem}}',
    );
    const js = chunk(files);
    // Rolldown inlines the short class strings of `base` and `big`.
    assert.match(js, /cn\("A B", "D Q", window\.location\.hash\)/);
    assert.doesNotMatch(js, /css`|scss`/);
  });

  test('replaces blocks in HTML and links the CSS file', async () => {
    const html = (await buildFixture('basic')).get('index.html')!;
    assert.match(html, /<main class="P N J L A">Hello<\/main>/);
    assert.match(html, /<link rel="stylesheet" href="\/pre.style.css">/);
  });

  test('resolves cn calls with static arguments at build time', async () => {
    const js = chunk(await buildFixture('basic'));
    // `color: red` is overridden by `color: green`.
    assert.match(js, /document\.body\.className = "H G E F C";/);
  });

  test('other cn calls use the project lookup table', async () => {
    const js = chunk(await buildFixture('basic'));
    assert.match(js, /var cn = \/\* @__PURE__ \*\/ createCn\(\{/);
    // The default `cn` from pre.style is dropped.
    assert.doesNotMatch(js, /^createCn\(\{\}\);$/m);
    assert.match(js, /"B": \{ "font-size": "Q" \}/);
    assert.match(
      js,
      /document\.body\.dataset\.dynamic = cn\("A B", "D Q", window\.location\.hash\);/,
    );
  });

  test('cn arguments that name a top-level const are resolved at build time', async () => {
    const js = chunk(await buildFixture('cn-consts'));
    // Blocks, strings, and other static cn calls, through consts.
    assert.match(js, /var both = "A";/);
    assert.match(js, /var chained = "A label G F D E";/);
    assert.match(js, /var deferred = \(\) => "A";/);
    // A parameter with the same name hides the const.
    assert.match(js, /return cn\(red, blue\);/);
    // Before the declaration, outside a function, it would throw.
    assert.match(js, /var tdz = cn\(early\);/);
    assert.match(js, /var dynamic = cn\(red, window\.location\.hash\);/);
  });

  test('the quotes option sets the quote character', async () => {
    const js = chunk(await buildFixture('basic', { quotes: 'single-quote' }));
    assert.match(js, /document\.body\.className = "H G E F C";/);
    const backtick = chunk(await buildFixture('basic', { quotes: 'backtick' }));
    assert.match(backtick, /document\.body\.className = `H G E F C`;/);
  });

  test('the output option sets the file name, banner, and footer', async () => {
    const files = await buildFixture('basic', {
      lightningcss: { minify: true },
      output: {
        file: 'css/pre.style.css',
        banner: '/* Top of file */',
        footer: '/* End of file */',
      },
    });
    const css = files.get('css/pre.style.css')!;
    assert.ok(css.startsWith('/* Top of file */\n.P{'));
    assert.ok(css.endsWith('}/* End of file */'));
    assert.match(files.get('index.html')!, /<link rel="stylesheet" href="\/css\/pre.style.css">/);
  });

  test('the sourceMap option writes a source map next to the CSS file', async () => {
    const files = await buildFixture('basic', {
      sourceMap: true,
      lightningcss: { minify: true },
      output: { banner: '/* a */\n/* b */' },
    });
    assert.match(files.get('pre.style.css')!, /\/\*# sourceMappingURL=pre.style.css.map \*\/\n$/);
    const map = JSON.parse(files.get('pre.style.css.map')!);
    assert.deepEqual(map.sources.toSorted(), [
      '../index.html',
      '../src/button.ts',
      '../src/main.ts',
    ]);
    // Two banner lines shift the mappings down.
    assert.ok(map.mappings.startsWith(';;'));
  });

  test('builds have no source map by default', async () => {
    const files = await buildFixture('basic');
    assert.equal(files.has('pre.style.css.map'), false);
    assert.doesNotMatch(files.get('pre.style.css')!, /sourceMappingURL/);
  });

  test('the layer option wraps the CSS in a cascade layer', async () => {
    const files = await buildFixture('basic', {
      layer: 'pre.style',
      lightningcss: { minify: true },
      output: { banner: '/* banner */' },
    });
    // The banner stays outside the layer.
    assert.match(
      files.get('pre.style.css')!,
      /^\/\* banner \*\/\n@layer pre\.style\{\.[A-Za-z]+\{/,
    );
  });

  test('an invalid layer name fails the build', async () => {
    await assert.rejects(buildFixture('basic', { layer: 'a b' }), /`layer` must be a layer name/);
  });

  test('prependFiles in package.json applies to scss blocks, and other imports from pre.style are kept', async () => {
    const files = await buildFixture('prepend', { lightningcss: { minify: true } });
    assert.equal(files.get('pre.style.css'), '.A{color:#639}');
    assert.match(chunk(files), /const value = "A";|var value = "A";/);
  });

  test('include and exclude in package.json choose the files scanned before the build', async () => {
    // Without the HTML file, its block isn't scanned. It's still replaced,
    // and named on demand after the scanned blocks.
    const files = await withField('basic', { exclude: '**/*.html' }, () =>
      buildFixture('basic', { lightningcss: { minify: true } }),
    );
    assert.match(files.get('index.html')!, /<main class="N O P Q A">Hello<\/main>/);
    assert.match(files.get('pre.style.css')!, /\.N\{padding-top:1rem\}/);
  });
});

describe('quirks mode', () => {
  test('warns once when index.html has no doctype', async () => {
    const { logged } = await warnings('quirks');
    assert.equal(logged.length, 1);
    assert.match(
      logged[0],
      /index\.html has no doctype.*set "quirksMode": true in the "pre\.style" field of your package\.json/,
    );
  });

  test("doesn't warn when index.html has a doctype", async () => {
    const { logged } = await warnings('basic');
    assert.deepEqual(logged, []);
  });

  test('quirksMode in package.json uses lowercase class names, without the warning', async () => {
    const { files, logged } = await withField('quirks', { quirksMode: true }, () =>
      warnings('quirks', { lightningcss: { minify: true } }),
    );
    assert.deepEqual(logged, []);
    assert.match(files.get('index.html')!, /<main class="[a-z_ ]+">/);
    assert.doesNotMatch(files.get('pre.style.css')!, /\.[A-Z]/);
  });
});

describe('importing virtual:pre.style.css', () => {
  test('Vite bundles the CSS, and the plugin does not write output.file', async () => {
    const files = await buildFixture('imported', { lightningcss: { minify: true } });
    assert.equal(files.get('pre.style.css'), undefined);
    const css = [...files].find(([name]) => name.endsWith('.css'));
    assert.match(css![0], /^assets\/index-.+\.css$/);
    assert.match(css![1], /\.A\{color:red\}/);
  });

  // Vite doesn't write source maps for bundled CSS, even with
  // `build.sourcemap`, so imported CSS only has a map in dev.
  test('the bundled CSS has no source map', async () => {
    const files = await buildFixture(
      'imported',
      { sourceMap: true },
      { build: { sourcemap: true } },
    );
    assert.ok(![...files.keys()].some((name) => name.endsWith('.css.map')));
  });
});

describe('component libraries', () => {
  // The libraries are installed into a real node_modules for these tests.
  const modules = `${fixture('library')}/node_modules`;
  before(() => cpSync(fixture('library-packages'), modules, { recursive: true }));
  after(() => rmSync(modules, { recursive: true, force: true }));

  test('dependencies with a pre.style field are compiled, with their own prepended files', async () => {
    const files = await buildFixture('library', { lightningcss: { minify: true } });
    // acme-ui and acme-icons (a dependency of acme-ui) each prepend their own
    // tokens. The app's `color: red` and acme-ui's share a class.
    assert.equal(files.get('pre.style.css'), '.C{width:16px}.B{padding-top:4px}.A{color:red}');
    const js = chunk(files);
    assert.match(js, /var app = "A";/);
    assert.match(js, /document\.body\.dataset\.button = "B A";/);
    assert.match(js, /document\.body\.dataset\.icon = "C";/);
    // plain-ui has no pre.style field, so it isn't compiled.
    assert.match(js, /var plain = css`margin-top: 0;`;/);
  });

  test('the libraries setting in package.json adds packages and leaves them out', async () => {
    const files = await withField(
      'library',
      { libraries: { 'plain-ui': true, 'acme-icons': false } },
      () => buildFixture('library', { lightningcss: { minify: true } }),
    );
    assert.equal(files.get('pre.style.css'), '.C{padding-top:4px}.A{color:red}.B{margin-top:0}');
    const js = chunk(files);
    assert.match(js, /document\.body\.dataset\.plain = "B";/);
    assert.match(js, /var icon = scss`width: \$icon-size;`;/);
  });

  test("in dev, libraries aren't pre-bundled or externalized, and render the same on the server", async () => {
    const server = await createServer({
      ...config('library', {}),
      server: { middlewareMode: true, ws: false },
    });
    try {
      assert.deepEqual(server.config.optimizeDeps.exclude, [
        'acme-ui',
        'acme-icons',
        '@pre.style/core/runtime',
        '@pre.style/core/runtime/dev',
      ]);
      assert.deepEqual(server.environments.ssr.config.resolve.noExternal, [
        'acme-ui',
        'acme-icons',
      ]);
      const id = `${modules}/acme-ui/index.js`;
      const client = await server.environments.client.transformRequest(id);
      const ssr = await server.environments.ssr.transformRequest(id);
      assert.equal(classString(client!.code), classString(ssr!.code));
    } finally {
      await server.close();
    }
  });
});

describe('Astro components', () => {
  // Stands in for Astro's own `pre` plugin, which compiles components to
  // TypeScript. The frontmatter moves down a line, as Astro's compiler moves
  // it, so the compiled positions differ from the component's.
  const astro: Plugin = {
    name: 'fake-astro',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.astro')) return;
      const [, frontmatter, template] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(code)!;
      return {
        code: `// Compiled.\n${frontmatter}\nexport default ${JSON.stringify(template)};\n`,
        moduleType: 'js',
      };
    },
  };
  const astroConfig = (options: PreStyleOptions = {}, name = 'astro'): InlineConfig => {
    const base = config(name, options);
    return { ...base, plugins: [...base.plugins!, astro] };
  };
  const card = `${fixture('astro')}/src/Card.astro`;
  const original = readFileSync(card, 'utf8');
  after(() => writeFileSync(card, original));

  test("replaces blocks in Astro's output, after scanning the component", async () => {
    const result = (await build(
      astroConfig({ lightningcss: { minify: true } }),
    )) as Rollup.RollupOutput;
    const files = new Map(
      result.output.map((item) => [
        item.fileName,
        item.type === 'chunk' ? item.code : String(item.source),
      ]),
    );
    assert.equal(files.get('pre.style.css'), '.C{color:red}.B{color:green}.A{color:#00f}');
    const js = chunk(files);
    assert.match(js, /document\.body\.className = "C";/);
    assert.match(js, /document\.body\.dataset\.both = "A";/);
    assert.doesNotMatch(js, /css`/);
  });

  // The component imports the CSS module itself, so it can load before the
  // stylesheet file, and the scan must find the file.
  test('scans stylesheet files imported only for their global rules', async () => {
    const result = (await build(
      astroConfig({ lightningcss: { minify: true } }, 'astro-reset'),
    )) as Rollup.RollupOutput;
    const css = result.output
      .filter((item) => item.fileName.endsWith('.css'))
      .map((item) => String((item as Rollup.OutputAsset).source))
      .join('');
    assert.match(css, /box-sizing:border-box/);
  });

  // Excluded from the scan, `late.ts` imports `late.css`, which loads after
  // the CSS module that `Layout.astro` imports beside it.
  test("styles from files the scan didn't find are an error, not left out", async () => {
    await withField('astro-reset', { exclude: 'src/late.ts' }, () =>
      assert.rejects(
        build(astroConfig({}, 'astro-reset')),
        /src\/late\.css added styles after the CSS was generated/,
      ),
    );
  });

  test("errors report the position in the component, not Astro's output", async () => {
    writeFileSync(card, original.replace('color: red;', 'color: red;\n  & > { }}'));
    const server = await createServer({
      ...astroConfig(),
      server: { middlewareMode: true, ws: false },
    });
    try {
      await assert.rejects(server.transformRequest('/src/Card.astro'), (error: Error) =>
        error.message.includes(`${card}:5:7: Invalid CSS`),
      );
    } finally {
      await server.close();
    }
  });
});

describe('stylesheet files', () => {
  test('imports with the pre.style attribute export each class string, and are built away', async () => {
    const files = await buildFixture('sheets', { lightningcss: { minify: true } });
    const css = files.get('pre.style.css')!;
    // `button.css`, `theme.scss`, and the block that composes from it.
    assert.match(css, /\.[A-Za-z]+\{color:red\}/);
    assert.match(css, /\.[A-Za-z]+:hover\{color:#00f\}/);
    assert.match(css, /\.[A-Za-z]+\{background-color:#fff\}/);
    assert.match(css, /\.[A-Za-z]+:hover \.[A-Za-z]+\{color:purple\}/);
    // Unused classes are still written, as CSS Modules does.
    assert.match(css, /letter-spacing:1px/);
    const js = chunk(files);
    assert.doesNotMatch(js, /pre\.style'|with \{|\.css|\.scss|__pre_style_/);
  });

  test('cn calls with stylesheet classes are resolved at build time', async () => {
    const js = chunk(await buildFixture('sheets'));
    // Static: `button` and `theme.surface` become one string.
    assert.match(js, /document\.body\.className = "[A-Za-z]+( [A-Za-z]+){2}";/);
    // `primary-button` composes `button`, so its own `color: green`
    // replaces `color: red`; with a runtime argument, cn runs in the browser.
    assert.match(
      js,
      /document\.body\.dataset\.primary = cn\("[A-Za-z]+ [A-Za-z]+", window\.location\.hash\);/,
    );
  });

  test('context classes get a marker, and blocks compose from stylesheet files', async () => {
    const files = await buildFixture('sheets', { lightningcss: { minify: true } });
    const css = files.get('pre.style.css')!;
    const [, marker, titleClass] = /\.([A-Za-z]+):hover \.([A-Za-z]+)\{color:purple\}/.exec(css)!;
    const js = chunk(files);
    // `card` is its `padding-top` class and its marker; `title` is its class.
    const card = /dataset\.card = "([\w ]+)";/.exec(js)![1].split(' ');
    assert.equal(card.length, 2);
    assert.ok(card.includes(marker));
    assert.match(js, new RegExp(`dataset\\.title = "${titleClass}";`));
    // The block composes `surface`, then adds `padding-top: 0`.
    const surface = /\.([A-Za-z]+)\{background-color:#fff\}/.exec(css)![1];
    assert.match(js, new RegExp(`composed = "${surface} [A-Za-z]+"`));
  });

  test('in dev, imports are rewritten to a stylesheet module that imports the CSS', async () => {
    const server = await createServer({
      ...config('sheets', {}),
      server: { middlewareMode: true, ws: false },
    });
    try {
      const main = await server.transformRequest('/src/main.ts');
      assert.doesNotMatch(main!.code, /with \{/);
      const url = /from "(\/@id\/__x00__pre\.style-sheet:[^"]+\/button\.css\.js)"/.exec(
        main!.code,
      )![1];
      // The browser's URL for the module's `\0` ID.
      const sheet = await server.transformRequest(url.replace('/@id/__x00__', '\0'));
      assert.match(sheet!.code, /^import "\/__pre\.style\.css";/);
      assert.match(sheet!.code, /export const button = "[A-Za-z]+ [A-Za-z]+";/);
      assert.match(
        sheet!.code,
        /const __pre_style_0 = "[\w ]+";\nexport \{ __pre_style_0 as "primary-button" \};/,
      );
      assert.match(sheet!.code, /export const unused = "[A-Za-z]+";/);

      // Asked for as a plain stylesheet, as Astro does for the page's styles,
      // it's empty: it isn't plain CSS.
      const plain = await server.transformRequest('/src/button.css?inline');
      assert.match(plain!.code, /export default ""/);

      // Changing the file updates its module, and the modules that compose from it.
      const file = `${fixture('sheets')}/src/theme.scss`;
      const graph = server.environments.client.moduleGraph;
      const themeId = `\0pre.style-sheet:${file}.js`;
      await server.environments.client.transformRequest(themeId);
      const plugin = (server.config.plugins as Plugin[]).find((p) => p.name === 'pre.style')!;
      const hotUpdate = plugin.hotUpdate as (
        this: unknown,
        options: { file: string; modules: unknown[] },
      ) => { id: string }[] | undefined;
      const affected = hotUpdate.call(
        { environment: server.environments.client },
        { file, modules: [] },
      );
      assert.deepEqual(
        affected?.map((module) => module.id).toSorted(),
        [`${fixture('sheets')}/src/main.ts`, themeId].toSorted(),
      );
      assert.ok(graph.getModuleById(themeId));
    } finally {
      await server.close();
    }
  });

  test('errors in a stylesheet file report the file', async () => {
    const file = `${fixture('sheets')}/src/button.css`;
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}\n.bad { composes: missing; }\n`);
    try {
      await assert.rejects(buildFixture('sheets'), /has no class `missing` to compose/);
    } finally {
      writeFileSync(file, original);
    }
  });
});

describe('package.json config', () => {
  test('options that moved to package.json fail with a pointer to it', () => {
    assert.throws(
      () => preStyle({ prependFiles: ['x.css'] } as PreStyleOptions),
      /The `prependFiles` option moved to the "pre\.style" field in your package\.json/,
    );
  });

  test('warns about unknown keys, and fails on invalid values', async () => {
    const { logged } = await withField('basic', { includes: 'src/**' }, () => warnings('basic'));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /"pre\.style" in .*basic\/package\.json: unknown key `includes`/);
    await assert.rejects(
      withField('basic', { quirksMode: 'yes' }, () => buildFixture('basic')),
      /`quirksMode` must be `true` or `false`/,
    );
    await assert.rejects(
      withField('basic', { keyframeLocalization: 1 }, () => buildFixture('basic')),
      /`keyframeLocalization` must be `true` or `false`/,
    );
  });

  test('keyframeLocalization in package.json gives keyframes generated names', async () => {
    const main = `${fixture('basic')}/src/main.ts`;
    const original = readFileSync(main, 'utf8');
    writeFileSync(
      main,
      `${original}\nexport const spinner = css\`@keyframes spin { to { rotate: 1turn } } animation-name: spin;\`;\n`,
    );
    try {
      const files = await withField('basic', { keyframeLocalization: true }, () =>
        buildFixture('basic', { lightningcss: { minify: true } }),
      );
      const css = files.get('pre.style.css')!;
      const name = /@keyframes ([A-Za-z]+)\{/.exec(css)![1];
      assert.notEqual(name, 'spin');
      assert.match(css, new RegExp(`animation-name:${name}\\}`));
    } finally {
      writeFileSync(main, original);
    }
  });
});

describe('component library fields', () => {
  const modules = `${fixture('library')}/node_modules`;
  before(() => cpSync(fixture('library-packages'), modules, { recursive: true }));
  after(() => rmSync(modules, { recursive: true, force: true }));

  test('app-only keys in a library field are ignored with a warning', async () => {
    const file = `${modules}/acme-icons/package.json`;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...pkg, 'pre.style': { ...pkg['pre.style'], quirksMode: true } }),
    );
    const { files, logged } = await warnings('library', { lightningcss: { minify: true } });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /acme-icons\/package\.json: `quirksMode` only applies to the app/);
    assert.match(files.get('pre.style.css')!, /\.[A-Z]\{width:16px\}/);
  });
});

describe('errors', () => {
  const main = `${fixture('errors')}/src/main.ts`;
  after(() => writeFileSync(main, 'export const ok = true;\n'));

  test('css used other than as a tagged template', async () => {
    writeFileSync(main, "import { css } from '@pre.style/core';\nexport const f = css;\n");
    await assert.rejects(
      buildFixture('errors'),
      /`css` from pre.style can only be used as a tagged template/,
    );
  });

  test('a runtime value in a selector', async () => {
    writeFileSync(
      main,
      "import { css } from '@pre.style/core';\nconst c = 'a';\nexport const f = css`\n  .${c} { color: red; }`;\n",
    );
    await assert.rejects(
      buildFixture('errors'),
      (error: Error) =>
        error.message.includes(`${main}:4:4: `) &&
        error.message.includes("can only be used in a declaration's value"),
    );
  });

  test('a block in a runtime value', async () => {
    writeFileSync(
      main,
      "import { css } from '@pre.style/core';\nexport const f = css`width: ${css`color: red;`};`;\n",
    );
    await assert.rejects(buildFixture('errors'), /can't be used in another block's/);
  });

  test('invalid CSS reports the file and position', async () => {
    writeFileSync(
      main,
      "import { css } from '@pre.style/core';\nexport const f = css`\n  color: red;\n  & > { }}`;\n",
    );
    await assert.rejects(buildFixture('errors'), (error: Error) =>
      error.message.includes(`${main}:4:7: Invalid CSS`),
    );
  });
});

describe('dev', () => {
  test('serves class strings and a CSS module that updates', async () => {
    const server = await createServer({
      ...config('basic', { lightningcss: { minify: true } }),
      server: { middlewareMode: true, ws: false },
    });
    try {
      const main = await server.transformRequest('/src/main.ts');
      // Vite rewrites the virtual import to its resolved ID.
      assert.match(main!.code, /^import "\/__pre.style.css";/);
      // Dev names blocks in the order they're served.
      assert.match(main!.code, /const base = "A B";/);

      const button = await server.transformRequest('/src/button.ts');
      const css = await server.transformRequest('/__pre.style.css');
      assert.match(css!.code, /padding-top:8px/);

      // The SSR environment shares the compiler, so it renders the same
      // class strings the browser hydrates. `button.ts`'s names depend on
      // the blocks named before it, so a separate compiler would differ.
      const ssrButton = await server.environments.ssr.transformRequest('/src/button.ts');
      assert.equal(classString(ssrButton!.code), classString(button!.code));
      assert.notEqual(classString(button!.code).split(' ')[0], 'A');
    } finally {
      await server.close();
    }
  });

  test('changing a prepended file updates the modules with blocks it applies to', async () => {
    const file = `${fixture('prepend')}/vars.scss`;
    const original = readFileSync(file, 'utf8');
    const server = await createServer({
      ...config('prepend', { lightningcss: { minify: true } }),
      server: { middlewareMode: true, ws: false },
    });
    try {
      const client = server.environments.client;
      await client.transformRequest('/src/main.ts');
      assert.match((await client.transformRequest('/__pre.style.css'))!.code, /color:#639/);

      writeFileSync(file, '$brand: teal;\n');
      await client.pluginContainer.watchChange(file, { event: 'update' });
      const plugin = (server.config.plugins as Plugin[]).find((p) => p.name === 'pre.style')!;
      const hotUpdate = plugin.hotUpdate as (
        this: unknown,
        options: { file: string; modules: unknown[] },
      ) => EnvironmentModuleNode[] | undefined;
      const affected = hotUpdate.call({ environment: client }, { file, modules: [] });
      assert.deepEqual(
        affected?.map((module) => module.id),
        [`${fixture('prepend')}/src/main.ts`],
      );

      // Vite invalidates them, and they compile with the new code.
      for (const module of affected!) client.moduleGraph.invalidateModule(module);
      await client.transformRequest('/src/main.ts');
      assert.match((await client.transformRequest('/__pre.style.css'))!.code, /color:teal/);
    } finally {
      writeFileSync(file, original);
      await server.close();
    }
  });

  test('changing the pre.style field warns that the dev server needs a restart', async () => {
    const logged: string[] = [];
    const logger = createLogger('silent');
    logger.warn = (message) => logged.push(message);
    await withField('prepend', { prependFiles: { scss: ['vars.scss'] } }, async () => {
      const server = await createServer({
        ...config('prepend', {}),
        customLogger: logger,
        server: { middlewareMode: true, ws: false },
      });
      const file = `${fixture('prepend')}/package.json`;
      try {
        // Other changes to package.json don't warn.
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...pkg, version: '1.0.0' }));
        server.watcher.emit('change', file);
        assert.deepEqual(logged, []);

        writeFileSync(file, JSON.stringify({ ...pkg, 'pre.style': { quirksMode: true } }));
        server.watcher.emit('change', file);
        assert.equal(logged.length, 1);
        assert.match(logged[0], /"pre\.style" field in package\.json changed\. Restart/);
      } finally {
        await server.close();
      }
    });
  });

  test('the CSS module maps to the blocks by default', async () => {
    const server = await createServer({
      ...config('basic', {}),
      server: { middlewareMode: true, ws: false },
    });
    try {
      await server.transformRequest('/src/main.ts');
      const css = await server.transformRequest('/__pre.style.css');
      const encoded =
        /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/.exec(
          css!.code,
        )![1];
      const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
      assert.deepEqual(map.sources, [`${fixture('basic')}/src/main.ts`]);
      assert.match(map.sourcesContent[0], /const base = css`/);
      // `sourceMap` turns on Vite's `css.devSourcemap`.
      assert.equal(server.config.css.devSourcemap, true);
    } finally {
      await server.close();
    }
  });

  test('class attributes say where they are written', async () => {
    const transformed = async (options: PreStyleOptions, mode?: string) => {
      const server = await createServer({
        ...config('jsx', options),
        mode,
        server: { middlewareMode: true, ws: false },
      });
      try {
        return (await server.transformRequest('/src/App.tsx'))!.code;
      } finally {
        await server.close();
      }
    };
    const code = await transformed({});
    assert.match(code, /className: box,\s*"data-pre-style-at": "src\/App\.tsx:10:9"/);
    assert.match(code, /className: "[^"]+",\s*"data-pre-style-from": "src\/App\.tsx:11:11"/);
    assert.match(code, /class: "plain",\s*"data-pre-style-from": "src\/App\.tsx:12:15"/);
    assert.equal((code.match(/data-pre-style-/g) ?? []).length, 3);
    assert.doesNotMatch(await transformed({ sourceAttributes: false }), /data-pre-style-/);
    assert.doesNotMatch(
      await transformed({ sourceAttributes: true, sourceMap: false }),
      /data-pre-style-/,
    );
    // Test runs (Vitest's mode) only have them when asked for.
    assert.doesNotMatch(await transformed({}, 'test'), /data-pre-style-/);
    assert.match(await transformed({ sourceAttributes: true }, 'test'), /data-pre-style-at/);
  });

  test('class attributes in Astro components say where they are written', async () => {
    // Writes `Card.astro` the way Astro's compiler does, as far as this test
    // needs, with a source map like its own: each attribute and prop maps to
    // where it starts.
    const compileAstro: Plugin = {
      name: 'fake-astro',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('.astro')) return;
        const s = new MagicString(code);
        let at = 0;
        const replace = (from: string, to: string) => {
          const start = code.indexOf(from, at);
          at = start + from.length;
          s.overwrite(start, at, to);
        };
        replace('---\n', '');
        replace('---\n', 'export default () => $$render`');
        replace(' ', '');
        replace('class={', '${$$addAttribute(');
        replace('}>', ', "class")}>');
        replace('<Box ', '${$$renderComponent($$result, "Box", Box, { ');
        replace('className={card}', '"className": card');
        replace(' tone=', ', "tone": ');
        replace(' />', ' })}');
        s.append('`;');
        return { code: s.toString(), map: s.generateMap({ hires: true }), moduleType: 'js' };
      },
    };
    const server = await createServer({
      ...config('jsx', {}),
      plugins: [...config('jsx', {}).plugins!, compileAstro],
      server: { middlewareMode: true, ws: false },
    });
    try {
      const { code } = (await server.transformRequest('/src/Card.astro'))!;
      assert.match(
        code,
        /\$\$addAttribute\(card, "class"\)\}\$\{\$\$addAttribute\("src\/Card\.astro:7:6", "data-pre-style-at"\)\}>/,
      );
      assert.match(code, /\{ "data-pre-style-from": "src\/Card\.astro:8:8", "className": card,/);
      assert.equal((code.match(/data-pre-style-/g) ?? []).length, 2);
    } finally {
      await server.close();
    }
  });

  test('the usages endpoint lists where classes are used', async () => {
    const server = await createServer({
      ...config('basic', {}),
      server: { port: 0, ws: false },
    });
    try {
      await server.listen();
      const url = server.resolvedUrls!.local[0];
      await server.transformRequest('/src/main.ts');
      const css = await server.transformRequest('/__pre.style.css');
      const className = /\.([\w-]+) ?\{/.exec(css!.code)![1];
      const response = await fetch(`${url}__pre.style/usages?classes=${className},nope`);
      assert.match(response.headers.get('content-type')!, /application\/json/);
      const { version, editor, root, classAttributes, rules } = await response.json();
      assert.equal(version, 1);
      assert.equal(editor, '/__open-in-editor');
      assert.equal(root, fixture('basic'));
      assert.equal(classAttributes, true);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].className, className);
      assert.equal(rules[0].sources[0].file, `${fixture('basic')}/src/main.ts`);
      assert.equal(rules[0].sources[0].path, 'src/main.ts');

      // A changed file's places are dropped until it compiles again.
      await server.environments.client.pluginContainer.watchChange(
        `${fixture('basic')}/src/main.ts`,
        { event: 'update' },
      );
      const updated = await fetch(`${url}__pre.style/usages?classes=${className}`);
      const files = (await updated.json()).rules[0].sources.map(
        ({ path }: { path: string }) => path,
      );
      assert.equal(files.includes('src/main.ts'), false);
    } finally {
      await server.close();
    }
  });

  test('LAUNCH_EDITOR defaults to VS Code in its terminal, unless it is set or sourceMap is off', async () => {
    const original = {
      LAUNCH_EDITOR: process.env.LAUNCH_EDITOR,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
    };
    const editorAfter = async (options: PreStyleOptions) => {
      const server = await createServer({
        ...config('basic', options),
        server: { middlewareMode: true, ws: false },
      });
      await server.close();
      return process.env.LAUNCH_EDITOR;
    };
    try {
      delete process.env.LAUNCH_EDITOR;
      process.env.TERM_PROGRAM = 'other';
      assert.equal(await editorAfter({}), undefined);
      process.env.TERM_PROGRAM = 'vscode';
      assert.equal(await editorAfter({ sourceMap: false }), undefined);
      assert.equal(await editorAfter({}), 'code');
      process.env.LAUNCH_EDITOR = 'webstorm';
      assert.equal(await editorAfter({}), 'webstorm');
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('sourceMap: false leaves out the usages endpoint', async () => {
    const server = await createServer({
      ...config('basic', { sourceMap: false }),
      server: { port: 0, ws: false },
    });
    try {
      await server.listen();
      const response = await fetch(`${server.resolvedUrls!.local[0]}__pre.style/usages?classes=A`);
      assert.doesNotMatch(response.headers.get('content-type') ?? '', /application\/json/);
    } finally {
      await server.close();
    }
  });

  test('sourceMap: false turns the source map off', async () => {
    const server = await createServer({
      ...config('basic', { sourceMap: false }),
      server: { middlewareMode: true, ws: false },
    });
    try {
      await server.transformRequest('/src/main.ts');
      const css = await server.transformRequest('/__pre.style.css');
      assert.doesNotMatch(css!.code, /sourceMappingURL/);
      assert.equal(server.config.css.devSourcemap, false);
    } finally {
      await server.close();
    }
  });
});

// Compiles an Astro component to its frontmatter, as far as these tests need.
const fakeAstro: Plugin = {
  name: 'fake-astro',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('.astro')) return;
    return code.split('---')[1];
  },
};

const outputJs = (files: Map<string, string>) =>
  [...files]
    .filter(([name]) => name.endsWith('.js'))
    .map(([, code]) => code)
    .join('\n');
const outputCss = (files: Map<string, string>) =>
  [...files]
    .filter(([name]) => name.endsWith('.css'))
    .map(([, code]) => code)
    .join('\n');

describe('runtime values', () => {
  test('a block with values calls the runtime', async () => {
    const files = await buildFixture('runtime-values');
    const code = outputJs(files);
    assert.match(outputCss(files), /@property --\w+ \{\s*syntax: "\*";\s*inherits: false;?\s*\}/);
    assert.match(outputCss(files), /width: var\(--\w+, 120px\)/);
    assert.match(code, /adoptedStyleSheets/);
    assert.doesNotMatch(code, /css`/);
  });

  test('production builds have short errors', async () => {
    const code = outputJs(await buildFixture('runtime-values'));
    assert.match(code, /https:\/\/pre\.style\/errors\/1/);
    assert.doesNotMatch(code, /must be strings or numbers/);
  });

  test('`cn` with a value runs in the browser and knows generated classes', async () => {
    const code = outputJs(await buildFixture('runtime-values'));
    assert.match(code, /createCn|generatedClasses|Object\.hasOwn/);
    assert.match(code, /super\.get/);
  });

  test('expressions run once, in order, with source maps', async () => {
    const files = await buildFixture(
      'runtime-values',
      {},
      { build: { minify: false, sourcemap: true } },
    );
    const code = outputJs(files);
    assert.match(code, /order\.push\("first"\),\s*order\.push\("second"\)/);
    assert.equal(code.match(/order\.push\("first"\)/g)!.length, 1);
    const map = [...files].find(([name]) => name.endsWith('.js.map'))![1];
    assert.ok(JSON.parse(map).sources.some((source: string) => source.endsWith('src/main.ts')));
  });

  test('apps without `${…}` ship no runtime', async () => {
    const code = outputJs(await buildFixture('basic'));
    for (const text of [
      'adoptedStyleSheets',
      'insertRule',
      'setProperty',
      'pre.style error',
      'super.get',
    ])
      assert.ok(!code.includes(text), text);
  });

  test('`cn` without `${…}` ships no runtime', async () => {
    const code = outputJs(await buildFixture('runtime-cn-only'));
    assert.match(code, /createCn|Object\.entries/);
    for (const text of ['adoptedStyleSheets', 'super.get', 'pre.style error'])
      assert.ok(!code.includes(text), text);
  });

  test("`${…}` in an Astro component's frontmatter is an error, not invalid CSS", async () => {
    const card = `${fixture('runtime-astro')}/src/Card.astro`;
    await assert.rejects(
      build({
        ...config('runtime-astro', {}),
        plugins: [...config('runtime-astro', {}).plugins!, fakeAstro],
      }),
      (error: Error) =>
        error.message.includes(card) && error.message.includes("Astro component's frontmatter"),
    );
  });

  test("a value's atom is in the scan, for an Astro client script", async () => {
    const file = `${fixture('runtime-astro')}/src/Card.astro`;
    const original = readFileSync(file, 'utf8');
    const script =
      'export const card = "a";\n---\n<script>\n  css`color: ${c}; margin-top: ${m}px;`;\n</script>\n';
    writeFileSync(file, `---\nimport { css } from '@pre.style/core';\n${script}`);
    try {
      // Only the frontmatter is compiled here, as the fake compiler can't split
      // scripts out, so the scan is what wrote this to the CSS.
      const files = await buildFixture(
        'runtime-astro',
        {},
        { plugins: [...config('runtime-astro', {}).plugins!, fakeAstro] },
      );
      assert.match(outputCss(files), /margin-top: var\(--\w+\)/);
    } finally {
      writeFileSync(file, original);
    }
  });

  test('`${…}` in HTML is an error', async () => {
    const file = `${fixture('runtime-html')}/index.html`;
    await assert.rejects(
      buildFixture('runtime-html'),
      (error: Error) =>
        error.message.includes(`${file}:`) && error.message.includes("can't be used in HTML"),
    );
  });

  test('the dev server uses full errors, and the server renders class strings', async () => {
    const server = await createServer({
      ...config('runtime-values', {}),
      server: { middlewareMode: true, ws: false },
      appType: 'custom',
      // The server resolves the runtime to its TypeScript source too.
      ssr: {
        resolve: {
          conditions: ['pre.style-source', ...defaultServerConditions],
          externalConditions: ['pre.style-source', 'node'],
        },
      },
    });
    try {
      const module = await server.ssrLoadModule('/src/main.ts');
      assert.match(module.withValue, /^\S+( \S+)* _\S+$/);
      assert.equal(module.withValue, module.again);
      const nothing = module.withNull as string;
      assert.doesNotMatch(nothing, /(^| )_/);
      assert.throws(() => module.invalid(), /must be strings or numbers/);
    } finally {
      await server.close();
    }
  });
});

describe('custom property localization', () => {
  test('is set in package.json, and renames what blocks declare', async () => {
    const files = await buildFixture('local-custom-properties');
    const css = outputCss(files);
    const code = outputJs(files);
    assert.doesNotMatch(css, /--gap|--brand/);
    assert.match(css, /var\(--shared\)/);
    assert.doesNotMatch(code, /--brand|pre\.style-variable/);
    assert.doesNotMatch(css, /pre\.style-variable/);
  });

  test('a value of the wrong type fails', async () => {
    await withField('basic', { customPropertyLocalization: 'yes' }, () =>
      assert.rejects(buildFixture('basic'), /customPropertyLocalization/),
    );
  });
});
