import { readFile, glob } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { MagicString } from 'magic-string';
import { createCn } from '@pre.style/core';
import type { CnTable } from '@pre.style/core';
import {
  createCompiler,
  findLibraries,
  interpolatedBlock,
  isIdentifier,
  PreStyleError,
  readConfig,
} from '@pre.style/core/compiler';
import type {
  Block,
  BlockVariable,
  CompiledStylesheet,
  Compiler,
  Lang,
  LibraryConfig,
  LightningOptions,
  PackageConfig,
  ResolvedLibrary,
} from '@pre.style/core/compiler';
import type { EnvironmentModuleNode, Plugin, ResolvedConfig, Rollup, ViteDevServer } from 'vite';
import { FindError, findInHtml, findInScript, locateIn, SHEET_IMPORT } from './find.ts';
import type { CnCall, FoundBlock, FoundImport, ScriptAnalysis, SheetClass } from './find.ts';

export type { LibraryConfig, PackageConfig };

// Options about how the build writes its output. Options every tool must
// agree on (`include`, `exclude`, `prependFiles`, `libraries`,
// `quirksMode`, and `keyframeLocalization`) are set in the `pre.style` field
// of the app's package.json.
export interface PreStyleOptions {
  // Options passed through to Lightning CSS.
  lightningcss?: LightningOptions;
  // Generate a source map for the output CSS. Defaults to on in dev and off
  // in builds.
  sourceMap?: boolean;
  // Wrap the output CSS in a cascade layer: `false` (the default) for none,
  // `''` for an unnamed layer, or the layer's name.
  layer?: false | string;
  // Quote character around the class string that replaces each block.
  quotes?: 'single-quote' | 'double-quote' | 'backtick';
  output?: {
    // Path and name of the output CSS file, relative to `build.outDir`.
    file?: string;
    // Prepended to the output CSS.
    banner?: string;
    // Appended to the output CSS.
    footer?: string;
  };
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const HTML = /\.html$/;
const ASTRO = /\.astro$/;
// An Astro component's client script, compiled to its own module.
const ASTRO_SCRIPT = /\.astro\?astro&type=script&/;
const DEFAULT_INCLUDE = ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,html,astro}'];
const NODE_MODULES = '**/node_modules/**';
// A doctype at the start of an HTML file, after any whitespace and comments.
// Legacy doctypes that still trigger quirks mode aren't detected.
const DOCTYPE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype\s/i;
const QUOTES = { 'single-quote': "'", 'double-quote': '"', backtick: '`' };

// Options that moved to the `pre.style` field in package.json in 3.1.
const MOVED_OPTIONS = ['include', 'exclude', 'prependFiles', 'libraries', 'quirksMode'];

// Stylesheet imports are rewritten to this query, which the plugin resolves
// to a module ID that Vite's CSS plugins don't match.
const SHEET_QUERY = '?pre.style';
const SHEET_PREFIX = '\0pre.style-sheet:';
const SHEET_SUFFIX = '.js';
const sheetLang = (file: string): Lang => (file.endsWith('.scss') ? 'scss' : 'css');

const CN_ID = 'virtual:pre.style/cn';
const RESOLVED_CN_ID = '\0virtual:pre.style/cn';
// The dev CSS module. Its resolved ID has no `\0`, so Vite's CSS plugin
// handles it (including HMR).
const CSS_ID = 'virtual:pre.style.css';
const RUNTIME_ID = '@pre.style/core/runtime';
const RUNTIME_DEV_ID = '@pre.style/core/runtime/dev';
// What a block with `${…}` calls.
const DYNAMIC_LOCAL = '__pre_style_dynamic';
const RESOLVED_CSS_ID = '/__pre.style.css';
// Where the browser DevTools extension asks where classes are used, as
// `?classes=A,B`. Bump the version when the response changes.
const USAGES_PATH = '/__pre.style/usages';
const USAGES_VERSION = 1;

const toArray = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const cleanId = (id: string) => id.replace(/[?#].*$/, '');

const block = (found: FoundBlock, file: string): Block => {
  const { code, lang, line, column, interpolation } = found;
  if (interpolation === undefined) return { code, lang, file, line, column };
  return interpolatedBlock({
    strings: interpolation.strings,
    expressions: interpolation.expressions.map((expression) => expression.code),
    lang,
    file,
    line,
    column,
  });
};

// The blocks in an HTML file. It has no JavaScript to run, so no runtime values.
const htmlBlocks = (html: string, file: string): FoundBlock[] => {
  const found = findInHtml(html);
  for (const { code, line, column } of found)
    if (code.includes('${'))
      throw new PreStyleError(
        `${file}:${line}:${column}: \`\${…}\` can't be used in HTML, because no code there could set the value. Use a constant, or a block in a script.`,
        null,
      );
  return found;
};

const ASTRO_MESSAGE =
  "`${…}` can't be used in an Astro component's frontmatter or template, because that code only runs on the server, so nothing could set the value in the browser. Use a client script or an island, or `style`.";

// Vite and Rollup errors take a location, so pre.style's own file:line:col
// prefix is left to them.
const fail = (
  context: {
    error(e: {
      message: string;
      id?: string;
      loc?: { file?: string; line: number; column: number };
    }): never;
  },
  error: unknown,
  id: string,
): never => {
  if (error instanceof FindError)
    context.error({
      message: error.message,
      id,
      loc: { file: id, line: error.line, column: error.column - 1 },
    });
  if (error instanceof PreStyleError) context.error({ message: error.message, id });
  throw error;
};

export default function preStyle(options: PreStyleOptions = {}): Plugin[] {
  for (const key of MOVED_OPTIONS) {
    if (Object.hasOwn(options, key))
      throw new Error(
        `[pre.style] The \`${key}\` option moved to the "pre.style" field in your package.json, so every tool that reads your styles shares it.`,
      );
  }
  const quote = QUOTES[options.quotes ?? 'double-quote'];
  const outputFile = options.output?.file ?? 'pre.style.css';
  const banner = options.output?.banner ?? '';
  const footer = options.output?.footer ?? '';

  let config: ResolvedConfig;
  // The app's package.json field, and the directory its paths are relative
  // to.
  let app: { dir: string; config: PackageConfig } = { dir: process.cwd(), config: {} };
  let configWarnings: string[] = [];
  let libraries: ResolvedLibrary[] = [];
  const inLibrary = (file: string) => libraries.some(({ dir }) => file.startsWith(dir + sep));
  let server: ViteDevServer | undefined;
  let compiler: Compiler;
  let table: { revision: number; table: CnTable; cn: ReturnType<typeof createCn> } | undefined;
  // In dev, the client and SSR environments share one compiler, so the
  // server renders the same class strings the browser hydrates.
  let devCompiler: Promise<Compiler> | undefined;
  // Whether a build environment imported the CSS module, in which case Vite
  // or the framework bundles the CSS and the plugin doesn't write
  // `output.file`. Astro, for one, imports it only in its server
  // environments, which it builds before the client.
  let cssImported = false;
  // The compiler's revision when this build environment loaded the CSS
  // module, whose contents are fixed then.
  let cssRevision: number | undefined;
  // HTML files already warned about a missing doctype.
  const warnedDoctype = new Set<string>();
  // For each file a module's class strings depend on (through `composes`
  // or Sass loads), the IDs of those modules, so dev updates them.
  const dependents = new Map<string, Set<string>>();
  const track = (context: { addWatchFile(file: string): void }, files: string[], id: string) => {
    for (const file of files) {
      context.addWatchFile(file);
      let ids = dependents.get(file);
      if (ids === undefined) dependents.set(file, (ids = new Set()));
      ids.add(id);
    }
  };

  const compileSheet = async (file: string): Promise<CompiledStylesheet> =>
    compiler.stylesheet({ code: await readFile(file, 'utf8'), lang: sheetLang(file), file });

  // The project's table, and a `cn` bound to it for build-time calls.
  const current = () => {
    if (table === undefined || table.revision !== compiler.revision) {
      const compiled = compiler.cnTable();
      table = { revision: compiler.revision, table: compiled, cn: createCn(compiled) };
    }
    return table;
  };

  // Reloads the dev CSS and `cn` modules after new classes are added.
  const update = (revision: number) => {
    if (server === undefined || compiler.revision === revision) return;
    for (const environment of Object.values(server.environments)) {
      for (const id of [RESOLVED_CSS_ID, RESOLVED_CN_ID]) {
        const module = environment.moduleGraph.getModuleById(id);
        if (module === undefined) continue;
        // Invalidated now, so the next request regenerates it. Only the
        // browser gets an HMR update: reloading on the server restarts its
        // whole module runner.
        environment.moduleGraph.invalidateModule(module);
        if (environment.config.consumer === 'client') void environment.reloadModule(module);
      }
    }
  };

  // Rules added after the CSS module loaded would be missing from the
  // build, so they're an error. They come from files the scan didn't find.
  const checkLate = (
    context: { error(e: { message: string; id?: string }): never },
    file: string,
  ) => {
    if (cssRevision === undefined || compiler.revision === cssRevision) return;
    context.error({
      message: `${relative(config.root, file)} added styles after the CSS was generated, so they would be missing from the build. pre.style finds styles when the build starts: import stylesheet files with static imports, and include the file in the "include" globs of the "pre.style" field in your package.json.`,
      id: file,
    });
  };

  // The output CSS with the banner and footer, and its source map (when
  // `sourceMap` is on) as a parsed object.
  const outputCss = () => {
    const { code, map } = compiler.css();
    let json: { mappings: string; sources: string[] } | null = null;
    if (map !== null) {
      json = JSON.parse(map);
      // Lines added by the banner shift the mappings down.
      const bannerLines = banner ? banner.split('\n').length - (banner.endsWith('\n') ? 1 : 0) : 0;
      json!.mappings = ';'.repeat(bannerLines) + json!.mappings;
    }
    return {
      code: `${banner}${banner && !banner.endsWith('\n') ? '\n' : ''}${code}${footer}`,
      map: json,
    };
  };

  // Replaces a script's blocks with their class strings, and rewrites its
  // `@pre.style/core` imports. `source` is the file it was compiled from, if any,
  // which errors and source maps point to instead.
  const rewrite = async (
    context: Rollup.TransformPluginContext,
    code: string,
    id: string,
    file: string,
    source?: string,
  ): Promise<Rollup.TransformResult> => {
    const revision = compiler.revision;

    let analysis: ScriptAnalysis | null;
    const s = new MagicString(code);
    try {
      // Compiled Astro components are TypeScript.
      analysis = findInScript(source === undefined ? file : `${file}.ts`, code);
      if (analysis === null) return;
      if (source !== undefined) locateIn(analysis.blocks, source);
      const classes = new Map<FoundBlock, string>();
      const variables = new Map<FoundBlock, BlockVariable[]>();
      for (const found of analysis.blocks) {
        const expression = found.interpolation?.expressions[0];
        if (expression !== undefined && ASTRO.test(id))
          throw new FindError(ASTRO_MESSAGE, expression.line, expression.column);
        const b = block(found, file);
        classes.set(found, compiler.classString(b));
        const blockVariables = compiler.variables(b);
        if (blockVariables.length > 0) variables.set(found, blockVariables);
        track(context, compiler.dependencies(b), id);
      }

      // Classes from stylesheet files, for `cn` calls.
      const sheets = new Map<string, Promise<Map<string, string>>>();
      const sheetClass = async ({ sheet, name }: SheetClass) => {
        let exports = sheets.get(sheet.specifier);
        if (exports === undefined) {
          exports = (async () => {
            const resolved = await context.resolve(sheet.specifier, file);
            if (resolved === null) return new Map();
            return new Map((await compileSheet(cleanId(resolved.id))).exports);
          })();
          sheets.set(sheet.specifier, exports);
        }
        return (await exports).get(name) ?? '';
      };

      // `cn` calls with static arguments are resolved now. Blocks written
      // inside them are replaced along with the call; blocks and calls they
      // name through a `const` are replaced where they're written.
      const resolved = new Set<FoundBlock>();
      const values = new Map<CnCall, Promise<string>>();
      const resolveCall = (call: CnCall): Promise<string> => {
        let result = values.get(call);
        if (result === undefined) {
          result = (async () => {
            const args: string[] = [];
            for (const arg of call.args!) {
              if (typeof arg === 'string') args.push(arg);
              else if ('sheet' in arg) args.push(await sheetClass(arg));
              else if ('args' in arg) args.push(await resolveCall(arg));
              else {
                args.push(classes.get(arg)!);
                if (call.start <= arg.start && arg.end <= call.end) resolved.add(arg);
              }
            }
            return current().cn(...args);
          })();
          values.set(call, result);
        }
        return result;
      };
      for (const call of analysis.cnCalls)
        if (call.args !== null)
          s.overwrite(call.start, call.end, quoted(await resolveCall(call), quote));
      for (const [found, value] of classes) {
        if (resolved.has(found)) continue;
        const blockVariables = variables.get(found);
        if (blockVariables === undefined) {
          s.overwrite(found.start, found.end, quoted(value, quote));
          continue;
        }
        // Only the text around the expressions is replaced, so they keep their
        // source maps, and each runs once, in order.
        const { expressions } = found.interpolation!;
        const list = blockVariables.map((variable) =>
          JSON.stringify([
            variable.name,
            variable.slot.strings,
            variable.slot.expressions,
            ...(variable.selector !== null
              ? [
                  variable.property === `--${variable.name}` ? 0 : variable.property,
                  variable.selector,
                ]
              : variable.property === `--${variable.name}`
                ? []
                : [variable.property]),
          ]),
        );
        s.overwrite(
          found.start,
          expressions[0].start,
          `${DYNAMIC_LOCAL}(${quoted(value, quote)},[`,
        );
        for (let i = 1; i < expressions.length; i++)
          s.overwrite(expressions[i - 1].end, expressions[i].start, ',');
        s.overwrite(expressions.at(-1)!.end, found.end, `],${list.join(',')})`);
      }
      // After any directives, such as `'use client'`, since a block's file
      // always imports from `@pre.style/core`.
      if (variables.size > 0) {
        const name = app.config.quirksMode ? 'dynamicLowercase' : 'dynamic';
        const from =
          config.command === 'build' && config.isProduction ? RUNTIME_ID : RUNTIME_DEV_ID;
        s.appendLeft(
          analysis.imports[0].start,
          `import { ${name} as ${DYNAMIC_LOCAL} } from ${JSON.stringify(from)};\n`,
        );
      }
      for (const statement of analysis.imports)
        s.overwrite(statement.start, statement.end, rewriteImport(statement));
      // The attributes are removed (browsers reject unknown types), and the
      // query marks the import for `resolveId`.
      for (const sheet of analysis.sheets)
        s.overwrite(sheet.start, sheet.end, JSON.stringify(sheet.specifier + SHEET_QUERY));
    } catch (error) {
      return fail(context, error, file);
    }
    checkLate(context, file);

    // In dev, the CSS is a module that each file with blocks imports, so
    // it loads after the file's classes are known.
    if (config.command !== 'build') {
      s.prepend(`import ${JSON.stringify(CSS_ID)};\n`);
      update(revision);
    }
    return {
      code: s.toString(),
      map: s.generateMap({ source: file, hires: 'boundary', includeContent: true }),
    };
  };

  const main: Plugin = {
    name: 'pre.style',
    enforce: 'pre',

    config(userConfig, env) {
      cssImported = false;
      const read = readConfig(resolve(userConfig.root ?? process.cwd()));
      app = read;
      configWarnings = [...read.warnings];
      libraries = findLibraries(app.dir, app.config.libraries, (message) =>
        configWarnings.push(message),
      );
      const names = libraries.map(({ name }) => name);
      return {
        // Vite only passes CSS source maps to the browser in dev with
        // `css.devSourcemap`, so `sourceMap` turns it on unless it's set.
        ...((options.sourceMap ?? env.command === 'serve') &&
          userConfig.css?.devSourcemap === undefined && { css: { devSourcemap: true } }),
        // Libraries are compiled from their source: not pre-bundled in dev,
        // and not left for Node to load on the server, so their blocks reach
        // this plugin.
        // The runtime has no dependencies, so it needs no pre-bundling, which
        // would reload the page when the first `${…}` is found.
        optimizeDeps: { exclude: [...names, RUNTIME_ID, RUNTIME_DEV_ID] },
        ssr: { noExternal: names },
      };
    },

    configResolved(resolved) {
      config = resolved;
      for (const message of configWarnings) config.logger.warn(`[pre.style] ${message}`);
      configWarnings = [];
    },

    configureServer(devServer) {
      server = devServer;
      if (options.sourceMap === false) return;
      // The DevTools extension opens files through Vite's `/__open-in-editor`,
      // whose guess can pick a terminal editor in the dev server's terminal.
      // Elsewhere, the guess is left alone.
      if (process.env.TERM_PROGRAM === 'vscode') process.env.LAUNCH_EDITOR ||= 'code';
      // Vite's host and CORS checks run before this hook's middleware.
      devServer.middlewares.use(USAGES_PATH, (req, res) => {
        const classes = new URLSearchParams(req.url?.split('?')[1]).get('classes') ?? '';
        const usages = compiler?.usages(classes.split(',')) ?? [];
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            version: USAGES_VERSION,
            // `/__open-in-editor` is behind the base, unlike this endpoint.
            editor: `${config.base}__open-in-editor`,
            rules: usages.map((usage) => ({
              ...usage,
              sources: usage.sources.map((source) => ({
                ...source,
                path: relative(config.root, source.file).split(sep).join('/'),
              })),
            })),
          }),
        );
      });
    },

    // Runs before Vite invalidates the file's modules, which add its current
    // places back as they compile. Once per change, not per transform: an
    // Astro component's frontmatter and scripts are separate modules.
    watchChange(file) {
      if (server !== undefined) compiler?.forgetSources(file);
    },

    async buildStart() {
      const create = () =>
        createCompiler({
          prependFiles: app.config.prependFiles,
          libraries: libraries.map(({ dir, prependFiles, keyframeLocalization }) => ({
            dir,
            prependFiles,
            keyframeLocalization,
          })),
          lightningcss: options.lightningcss,
          sourceMap: options.sourceMap ?? config.command !== 'build',
          root: app.dir,
          warn: (message) => config.logger.warn(`[pre.style] ${message}`),
          quirksMode: app.config.quirksMode,
          keyframeLocalization: app.config.keyframeLocalization,
          layer: options.layer,
        });
      // Dev names blocks on demand, as they're served.
      if (config.command !== 'build') {
        compiler = await (devCompiler ??= create());
        return;
      }
      // Each build environment scans the same files, so they assign the
      // same names.
      compiler = await create();
      table = undefined;
      cssRevision = undefined;

      // The app's files, then each library's, as absolute paths.
      const files = new Set<string>();
      const add = async (cwd: string, include: string[], exclude: string[]) => {
        // As patterns, not a function: Node passes a function only each
        // entry's name, not its path from `cwd`.
        for await (const file of glob(include, { cwd, exclude })) files.add(resolve(cwd, file));
      };
      const outDir = `${relative(app.dir, resolve(config.root, config.build.outDir))}/**`;
      const { include, exclude } = app.config;
      await add(app.dir, include ? toArray(include) : DEFAULT_INCLUDE, [
        ...toArray(exclude),
        NODE_MODULES,
        outDir,
      ]);
      for (const library of libraries)
        await add(library.dir, library.include, [...library.exclude, NODE_MODULES]);

      // Stylesheet files the scanned files import, which are scanned after
      // them.
      const sheets = new Set<string>();
      // Sorted, so names don't depend on the order the file system lists files.
      for (const id of [...files].toSorted()) {
        const code = await readFile(id, 'utf8');
        const imported = [...code.matchAll(SHEET_IMPORT)].map((match) => match[2]);
        if (!code.includes('css`') && imported.length === 0) continue;
        let specifiers: string[] = [];
        try {
          // Astro components aren't scripts until Astro compiles them, so
          // their blocks and imports are found by text matching, like
          // HTML's. Only counts depend on the scan, so a block Astro leaves
          // out costs no more than a longer name.
          let found: FoundBlock[] = [];
          if (HTML.test(id)) found = htmlBlocks(code, id);
          else if (ASTRO.test(id)) {
            // A block with `${…}` is in a client script, or an error when
            // it's compiled. Text matching can't tell where it ends.
            if (code.includes('@pre.style/core'))
              found = findInHtml(code).filter((b) => !b.code.includes('${'));
            specifiers = imported;
          } else {
            const analysis = findInScript(id, code);
            found = analysis?.blocks ?? [];
            specifiers = analysis?.sheets.map((sheet) => sheet.specifier) ?? [];
          }
          for (const b of found) compiler.scan(block(b, id));
        } catch (error) {
          fail(this, error, id);
        }
        for (const specifier of specifiers) {
          const resolved = await this.resolve(specifier, id);
          if (resolved !== null) sheets.add(cleanId(resolved.id));
        }
      }
      for (const file of [...sheets].toSorted()) {
        try {
          compiler.scanStylesheet({
            code: await readFile(file, 'utf8'),
            lang: sheetLang(file),
            file,
          });
        } catch (error) {
          fail(this, error, file);
        }
      }
      compiler.assignNames();
    },

    async resolveId(id, importer) {
      if (id === CN_ID) return RESOLVED_CN_ID;
      if (id === CSS_ID) return RESOLVED_CSS_ID;
      if (id.endsWith(SHEET_QUERY)) {
        const resolved = await this.resolve(id.slice(0, -SHEET_QUERY.length), importer, {
          skipSelf: true,
        });
        if (resolved === null) return null;
        return `${SHEET_PREFIX}${cleanId(resolved.id)}${SHEET_SUFFIX}`;
      }
    },

    async load(id) {
      if (id.startsWith(SHEET_PREFIX)) {
        const file = id.slice(SHEET_PREFIX.length, -SHEET_SUFFIX.length);
        const revision = compiler.revision;
        let compiled: CompiledStylesheet;
        try {
          compiled = await compileSheet(file);
        } catch (error) {
          return fail(this, error, file);
        }
        checkLate(this, file);
        track(this, [file, ...compiled.dependencies], id);
        let code = sheetModule(compiled.exports);
        if (config.command !== 'build') {
          code = `import ${JSON.stringify(CSS_ID)};\n${code}`;
          update(revision);
        }
        return { code, map: { mappings: '' } };
      }
      if (id === RESOLVED_CN_ID) {
        // Only apps with `${…}` load the runtime for this.
        const cnVariables = JSON.stringify(compiler.cnVariables());
        const cnTable = JSON.stringify(current().table);
        return cnVariables === '{}'
          ? `import { createCn } from '@pre.style/core';\nexport const cn = /* @__PURE__ */ createCn(${cnTable});\n`
          : `import { createCn } from '@pre.style/core';\nimport { generatedClasses } from ${JSON.stringify(RUNTIME_ID)};\nexport const cn = /* @__PURE__ */ createCn(${cnTable}, generatedClasses(${cnVariables}));\n`;
      }
      if (id === RESOLVED_CSS_ID) {
        if (config.command === 'build') {
          cssImported = true;
          cssRevision = compiler.revision;
        }
        // Vite combines this map with its own, for the browser in dev and for
        // the bundled CSS in builds (with `build.sourcemap`).
        const { code, map } = outputCss();
        return { code, map };
      }
    },

    transform(code, id) {
      const file = cleanId(id);
      // Files in node_modules are only compiled when they're in a library.
      if (
        !SCRIPT.test(file) ||
        (file.includes('/node_modules/') && !inLibrary(file)) ||
        !code.includes('pre.style')
      )
        return;
      return rewrite(this, code, id, file);
    },

    // Modules whose class strings depend on a changed file (a stylesheet
    // file, a file it composes from, or a file Sass loaded) are updated
    // with it.
    hotUpdate({ file, modules }) {
      const ids = dependents.get(file);
      if (ids === undefined) return;
      const graph = this.environment.moduleGraph;
      const affected = [...ids]
        .map((id) => graph.getModuleById(id))
        .filter((module): module is EnvironmentModuleNode => module !== undefined);
      if (affected.length === 0) return;
      return [...new Set([...modules, ...affected])];
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const id = context.filename;
        if (!app.config.quirksMode && !DOCTYPE.test(html) && !warnedDoctype.has(id)) {
          warnedDoctype.add(id);
          config.logger.warn(
            `[pre.style] ${relative(config.root, id)} has no doctype, so browsers render it in quirks mode, where class selectors ignore case and pre.style's classes collide. Add <!doctype html>, or set "quirksMode": true in the "pre.style" field of your package.json if you can't.`,
          );
        }
        const revision = compiler.revision;
        const s = new MagicString(html);
        try {
          for (const found of htmlBlocks(html, id))
            s.overwrite(found.start, found.end, compiler.classString(block(found, id)));
        } catch (error) {
          if (error instanceof PreStyleError) throw new Error(error.message, { cause: error });
          throw error;
        }
        update(revision);
        const tag =
          config.command === 'build'
            ? {
                tag: 'link',
                attrs: { rel: 'stylesheet', href: `${config.base}${outputFile}` },
                injectTo: 'head' as const,
              }
            : {
                tag: 'script',
                attrs: { type: 'module' },
                children: `import ${JSON.stringify(CSS_ID)};`,
                injectTo: 'head' as const,
              };
        return { html: s.toString(), tags: [tag] };
      },
    },

    generateBundle() {
      if (this.environment.config.consumer !== 'client' || cssImported) return;
      const { code, map } = outputCss();
      if (map === null) {
        this.emitFile({ type: 'asset', fileName: outputFile, source: code });
        return;
      }
      const mapFile = `${outputFile}.map`;
      const name = mapFile.split('/').pop();
      this.emitFile({
        type: 'asset',
        fileName: outputFile,
        source: `${code}\n/*# sourceMappingURL=${name} */\n`,
      });
      map.sources = map.sources.map((source) =>
        relative(resolve(config.root, config.build.outDir, outputFile, '..'), source),
      );
      this.emitFile({ type: 'asset', fileName: mapFile, source: JSON.stringify(map) });
    },
  };

  // Astro components are compiled to TypeScript by Astro's own `pre`
  // plugin, so their blocks are replaced after it, in its output. Their
  // client scripts are separate modules (`Foo.astro?astro&type=script&…`).
  const astro: Plugin = {
    name: 'pre.style:astro',

    async transform(code, id) {
      const file = cleanId(id);
      if (
        !(ASTRO.test(id) || ASTRO_SCRIPT.test(id)) ||
        (file.includes('/node_modules/') && !inLibrary(file)) ||
        !code.includes('pre.style')
      )
        return;
      return rewrite(this, code, id, file, await readFile(file, 'utf8'));
    },
  };

  return [main, astro];
}

// A stylesheet file's module: one constant export per class. Classes that
// aren't valid identifiers (such as `primary-button`) are exported by
// string name, imported as `import { 'primary-button' as primaryButton }`.
function sheetModule(exports: CompiledStylesheet['exports']): string {
  let local = 0;
  return exports
    .map(([name, value]) => {
      if (isIdentifier(name)) return `export const ${name} = ${JSON.stringify(value)};\n`;
      const binding = `__pre_style_${local++}`;
      return `const ${binding} = ${JSON.stringify(value)};\nexport { ${binding} as ${JSON.stringify(name)} };\n`;
    })
    .join('');
}

function quoted(value: string, quote: string): string {
  return `${quote}${value}${quote}`;
}

// Removes `css` and `scss` from `@pre.style/core` imports (the blocks are gone),
// and imports `cn` from the virtual module bound to the project's table.
function rewriteImport(statement: FoundImport): string {
  const named: string[] = [];
  const cn: string[] = [];
  const others: string[] = [];
  for (const specifier of statement.specifiers) {
    if (specifier.kind !== 'named') others.push(`import ${specifier.text} from '@pre.style/core';`);
    else if (specifier.imported === 'cn') cn.push(specifier.text);
    else if (specifier.imported !== 'css' && specifier.imported !== 'scss')
      named.push(specifier.text);
  }
  const statements = [...others];
  if (named.length > 0) statements.push(`import { ${named.join(', ')} } from '@pre.style/core';`);
  if (cn.length > 0) statements.push(`import { ${cn.join(', ')} } from ${JSON.stringify(CN_ID)};`);
  return statements.join(' ');
}
