import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import stylelint, { type Rule } from 'stylelint';
import type { Document } from 'postcss';
import {
  createCompiler,
  findLibraries,
  interpolatedBlock,
  PreStyleError,
  readConfig,
  type Block,
  type CompilerOptions,
  type LightningOptions,
} from '@pre.style/core/compiler';
import { blockInfo, misusedBlocks, type BlockInfo } from '../syntax.ts';
import { isStylesheet } from '../stylesheets.ts';

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

export const ruleName = 'pre-style/compile';

export const messages = ruleMessages(ruleName, {
  rejected: (message: string) => message,
});

const meta = {
  url: 'https://github.com/soluml/pre.style/tree/main/packages/stylelint#pre-stylecompile',
};

export interface CompileOptions {
  // Passed to Lightning CSS, as the bundler plugin's `lightningcss` option.
  lightningcss?: LightningOptions;
}

const HTML_MESSAGE =
  "`${…}` can't be used in HTML, because no code there could set the value. Use a constant, or a block in a script.";
const ASTRO_MESSAGE =
  "`${…}` can't be used in an Astro component's frontmatter or template, because that code only runs on the server, so nothing could set the value in the browser. Use a client script or an island, or `style`.";

// How long a package's compiler options are trusted, as for the
// stylesheet index.
const REVALIDATE_MS = 1000;

interface PackageOptions {
  options: CompilerOptions;
  stamp: string | null;
  checked: number;
}

const packages = new Map<string, PackageOptions>();

const stamp = (file: string) => {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${mtimeMs}:${size}`;
  } catch {
    return null;
  }
};

// The compiler options for a file's package: the nearest package.json's
// field, read again when it changes. Each package compiles its own files
// with its own prepended files, and its libraries with theirs.
function packageOptions(file: string): CompilerOptions {
  const { dir } = readConfig(dirname(file));
  const manifest = join(dir, 'package.json');
  const now = Date.now();
  const cached = packages.get(dir);
  if (cached !== undefined && now - cached.checked < REVALIDATE_MS) return cached.options;
  const current = stamp(manifest);
  if (cached !== undefined && cached.stamp === current) {
    cached.checked = now;
    return cached.options;
  }
  const { config } = readConfig(dir);
  const options: CompilerOptions = {
    root: dir,
    prependFiles: config.prependFiles,
    keyframeLocalization: config.keyframeLocalization,
    customPropertyLocalization: config.customPropertyLocalization,
    libraries: findLibraries(dir, config.libraries).map((library) => ({
      dir: library.dir,
      prependFiles: library.prependFiles,
      keyframeLocalization: library.keyframeLocalization,
      customPropertyLocalization: library.customPropertyLocalization,
    })),
    // Sass warnings aren't lint problems.
    warn: () => {},
  };
  packages.set(dir, { options, stamp: current, checked: now });
  return options;
}

const firstLine = (message: string) => message.split('\n', 1)[0].trim();

// Where an error is: core starts the message with `file:line:column: ` when
// it knows the file. Errors without one are reported at `fallback`. Only
// the first line is kept: Sass adds an excerpt whose line numbers count
// the prepended code, and the warning already points at the code.
function locateError(
  error: PreStyleError,
  file: string,
  fallback: { line: number; column: number },
) {
  const prefix = `${file}:`;
  if (error.message.startsWith(prefix)) {
    const match = /^(\d+):(\d+): ([\s\S]*)$/.exec(error.message.slice(prefix.length));
    if (match !== null) {
      const line = Number(match[1]);
      const column = Number(match[2]);
      const message = firstLine(match[3]);
      // A position before the block (line 0, for errors without one) means
      // the block as a whole.
      if (line >= fallback.line) return { line, column, message };
      return { ...fallback, message };
    }
  }
  return { ...fallback, message: firstLine(error.message) };
}

// The ranges of an Astro component's `<script>` contents, the only place
// a block can have `${…}`.
function scriptRanges(code: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const start = match.index + match[0].indexOf('>') + 1;
    ranges.push([start, start + match[1].length]);
  }
  return ranges;
}

function compilerBlock({ found, lang }: BlockInfo, file: string): Block {
  const { code, line, column, interpolation } = found;
  if (interpolation === undefined) return { code, lang, file, line, column };
  return interpolatedBlock({
    strings: interpolation.strings,
    expressions: interpolation.expressions.map((expression) => expression.code),
    lang,
    file,
    line,
    column,
  });
}

// Compiles each block, and each pre.style stylesheet file, the way the
// build does, and reports the build's errors: invalid CSS, Sass failures
// (with the package's prepended files, so their variables and mixins are
// defined), `${…}` where it can't be used, misused `composes`, and `css` or
// `scss` used other than as a tagged template.
const rule: Rule<boolean, CompileOptions> = (primary, secondary = {}) => {
  return async (root, result) => {
    const valid = validateOptions(
      result,
      ruleName,
      { actual: primary, possible: [true] },
      {
        actual: secondary,
        possible: { lightningcss: [(value: unknown) => typeof value === 'object'] },
        optional: true,
      },
    );
    if (!valid) return;

    const file = root.source?.input.file;
    if (file === undefined) return;
    const problem = (message: string, line: number, column: number) =>
      report({
        ruleName,
        result,
        node: root,
        message: messages.rejected,
        messageArgs: [message],
        start: { line, column },
        end: { line, column: column + 1 },
      });

    for (const misused of misusedBlocks(root))
      problem(misused.message, misused.line, misused.column);

    const block = blockInfo(root);
    const sheetLang = (root.raws as { preStyleLang?: 'css' | 'scss' }).preStyleLang;
    if (block === undefined && sheetLang === undefined) return;
    if (sheetLang !== undefined && !isStylesheet(file)) return;

    const options = { ...packageOptions(file), lightningcss: secondary.lightningcss };
    // A new compiler for each file, so nothing it caches is kept between
    // runs.
    const compiler = await createCompiler(options);

    if (sheetLang !== undefined) {
      try {
        compiler.stylesheet({ code: root.source!.input.css, lang: sheetLang, file });
      } catch (error) {
        if (!(error instanceof PreStyleError)) throw error;
        const located = locateError(error, file, { line: 1, column: 1 });
        problem(located.message, located.line, located.column);
      }
      return;
    }

    const { found, kind } = block!;
    const start = { line: found.line, column: found.column };
    if (found.interpolation !== undefined || (kind === 'html' && found.code.includes('${'))) {
      if (kind === 'html') return problem(HTML_MESSAGE, start.line, start.column);
      if (kind === 'component') {
        const code = (root.parent as Document | undefined)?.source?.input.css ?? '';
        const inScript = scriptRanges(code).some(
          ([from, to]) => from <= block!.start && block!.end <= to,
        );
        if (!inScript) return problem(ASTRO_MESSAGE, start.line, start.column);
      }
    }
    try {
      compiler.classString(compilerBlock(block!, file));
    } catch (error) {
      if (!(error instanceof PreStyleError)) throw error;
      const located = locateError(error, file, start);
      problem(located.message, located.line, located.column);
    }
  };
};

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = meta;

export default createPlugin(ruleName, rule);

// For tests: forgets every package's options.
export function clearCompileOptions(): void {
  packages.clear();
}
