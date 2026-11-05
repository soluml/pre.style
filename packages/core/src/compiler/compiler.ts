import { readFileSync } from 'node:fs';
import { dirname, relative, resolve as resolvePath, sep } from 'node:path';
import { transform } from 'lightningcss';
import type { Rule, SelectorList } from 'lightningcss';
import SweatMap from 'sweatmap';
import { dropOverridden, parseBlock, PreStyleError, valueOf } from './block.ts';
import type {
  Atom,
  AtRuleSegment,
  Compose,
  GlobalRule,
  Lang,
  LightningOptions,
  ParsedBlock,
  ParseOptions,
  Position,
  SassCompiler,
} from './block.ts';
import { interpolate } from './interpolate.ts';
import type { Slot } from './interpolate.ts';
import { print } from './print.ts';
import type { Printed } from './print.ts';
import { lvhfaRank, specificity, withClass } from './selectors.ts';
import { KEYFRAMES_PREFIX } from './keyframes.ts';
import { VARIABLE_PREFIX } from './variables.ts';
import { MARKER_PREFIX, markerKey, parseStylesheet } from './stylesheet.ts';
import type { ParsedStylesheet } from './stylesheet.ts';
import type { CnTable } from '../cn.ts';
import type { CnVariables } from '../runtime.ts';
import { SHORTHANDS } from '../shorthands.ts';

// Files prepended to blocks: an array for every block, or separate arrays
// for `css` and `scss` blocks.
export type PrependFiles = string[] | { css?: string[]; scss?: string[] };

export interface Library {
  // The library's directory. Blocks in files under it belong to the library.
  dir: string;
  // Prepended to the library's blocks only, instead of the app's
  // `prependFiles`. Relative to `dir`.
  prependFiles?: PrependFiles;
  // Localize the library's keyframes, instead of the app's setting.
  keyframeLocalization?: boolean;
  // Localize the library's custom properties, instead of the app's setting.
  customPropertyLocalization?: boolean;
}

export interface CompilerOptions {
  // Prepended to the app's blocks.
  prependFiles?: PrependFiles;
  // Component libraries, whose blocks get their own prepended files.
  libraries?: Library[];
  lightningcss?: LightningOptions;
  // Generate a source map for the output CSS.
  sourceMap?: boolean;
  // The directory `prependFiles` paths are relative to.
  root?: string;
  // Receives Sass warnings. Defaults to `console.warn`.
  warn?: (message: string) => void;
  // Lowercase class names only, for pages in quirks mode, where class
  // selectors ignore case. Names get longer.
  quirksMode?: boolean;
  // Give each `@keyframes` in the app's blocks and stylesheet files a
  // generated name, used only in its own block or file.
  keyframeLocalization?: boolean;
  // Give each custom property declared in the app's blocks and stylesheet files
  // a generated name, used only in that block or file.
  customPropertyLocalization?: boolean;
  // Wrap the output in a cascade layer: `false` for none, `''` for an
  // unnamed layer, or the layer's name.
  layer?: false | string;
}

export interface Block {
  code: string;
  lang: Lang;
  // Where the block's code starts, for errors and source maps. Lines and
  // columns start from 1.
  file?: string;
  line?: number;
  column?: number;
  // What each `${…}` holds, for a block from `interpolatedBlock`.
  slots?: Slot[];
}

// A variable a block sets at runtime.
export interface BlockVariable {
  // Its short name, which starts the classes generated for its values.
  name: string;
  // The custom property it sets.
  property: string;
  // The text and expressions that make up its value.
  slot: Slot;
  // Where to set it, split where the generated class goes, when the
  // declaration reading it isn't on the element. Null when it is.
  selector: string[] | null;
}

// A stylesheet file, imported with `with { type: 'pre.style' }`. Each class
// is exported with its class string.
export interface Stylesheet {
  code: string;
  lang: Lang;
  // The file's absolute path. `composes … from` and Sass loads resolve from
  // it.
  file: string;
}

export interface CompiledStylesheet {
  // Each exported class and its class string, in the order the classes
  // first appear.
  exports: [name: string, classString: string][];
  // Other files the class strings depend on, as absolute paths: files
  // composed from, and files Sass loaded.
  dependencies: string[];
}

// Atoms a class string is made of, and the rest of its names: markers
// (as marker keys) and global classes from `composes … from global`.
interface Resolved {
  atoms: Atom[];
  extras: string[];
}

interface AtomRecord {
  atom: Atom;
  // Assigned when first needed, so `assignNames` can name scanned atoms by
  // how often they're used.
  className: string | null;
  order: number;
  // The first place the atom appears, for the source map.
  source: Source | null;
  // Every place the atom appears, when `sourceMap` is on, by location.
  sources: Map<string, Source>;
  // Its rule as text, once `usages` has asked for it.
  printed: string | null;
}

interface GlobalRecord {
  global: GlobalRule;
  order: number;
  source: Source | null;
}

export interface Source {
  file: string;
  line: number;
  column: number;
}

// An atomic class as it's written to the output, and everywhere it's used,
// for tools that trace a class back to its blocks.
export interface ClassUsage {
  className: string;
  selector: string;
  // Outermost first, such as `@media (min-width: 768px)`.
  atRules: string[];
  declaration: string;
  property: string;
  // The longhands the property covers, if it's a shorthand.
  covers: string[];
  important: boolean;
  specificity: [ids: number, classes: number, types: number];
  // Its position in the output, for the cascade.
  order: number;
  sources: Source[];
}

const RANGES = {
  Digits: { start: '0030', end: '0039' },
  Uppercase: { start: '0041', end: '005A' },
  Lowercase: { start: '0061', end: '007A' },
  Hyphen: { start: '002D', end: '002D' },
  Underscore: { start: '005F', end: '005F' },
};

const NAME_OPTIONS = {
  cssSafe: true,
  // Only `0-9`, `A-Z`, `a-z`, `-`, and `_`, with letters first so the
  // shortest names are letters. These replace Sweatmap's default ranges, so
  // names never use other characters, such as U+00A0 (a no-break space),
  // which `cn` would split on. `cssSafe` keeps names from starting with a
  // digit, `--`, or `-` and a digit.
  ranges: RANGES,
};

// In quirks mode, `.A` and `.a` match the same elements, so class names leave
// out uppercase letters. Prefixes are only used in the `cn` table, so they
// keep both cases.
const QUIRKS_NAME_OPTIONS = {
  cssSafe: true,
  ranges: Object.fromEntries(Object.entries(RANGES).filter(([name]) => name !== 'Uppercase')),
};

// A block with `${…}`, from the text around its expressions and their source.
export function interpolatedBlock(
  block: Omit<Block, 'code' | 'slots'> & { strings: string[]; expressions: string[] },
): Block {
  const { strings, expressions, ...rest } = block;
  try {
    return { ...rest, ...interpolate(strings, expressions, block.lang) };
  } catch (error) {
    throw error instanceof PreStyleError ? locate(error, { ...rest, code: '' }) : error;
  }
}

export async function createCompiler(options: CompilerOptions = {}): Promise<Compiler> {
  let sass: SassCompiler | null = null;
  try {
    sass = await import('sass');
  } catch {
    // Sass is optional. Parsing an scss block reports that it's missing.
  }
  return new Compiler(options, sass);
}

export class Compiler {
  readonly #parseOptions: Omit<
    ParseOptions,
    'prepend' | 'keyframeLocalization' | 'customPropertyLocalization'
  >;
  readonly #options: CompilerOptions;
  // Prepended code for the app's blocks, and for each library's, with the
  // most deeply nested library first.
  readonly #prepend: Record<Lang, string>;
  readonly #libraries: {
    dir: string;
    prepend: Record<Lang, string>;
    keyframeLocalization: boolean;
    customPropertyLocalization: boolean;
  }[];
  // The layer the output is wrapped in, as parsed, or null for none.
  readonly #layer: Rule | null;
  readonly #blocks = new Map<string, ParsedBlock>();
  readonly #stylesheets = new Map<string, ParsedStylesheet>();
  readonly #root: string;

  // One name list for every class, one for prefixes (the at-rules and
  // selector variant a class is under), which only the `cn` table uses, and
  // one each for localized keyframes and runtime variables.
  readonly #names: {
    atoms: SweatMap;
    prefixes: SweatMap;
    keyframes: SweatMap;
    variables: SweatMap;
  };
  // How often each class, prefix, localized keyframes, and variable is used
  // across scanned blocks.
  readonly #counts = {
    atoms: new Map<string, number>(),
    prefixes: new Map<string, number>(),
    keyframes: new Map<string, number>(),
    variables: new Map<string, number>(),
  };

  readonly #atoms = new Map<string, AtomRecord>();
  readonly #globals = new Map<string, GlobalRecord>();
  // The current global for each overridable at-rule.
  readonly #overrides = new Map<string, string>();
  // Each runtime variable's custom property, or null for `--<its name>`.
  readonly #variables = new Map<string, string | null>();
  #order = 0;

  constructor(options: CompilerOptions, sass: SassCompiler | null) {
    this.#options = options;
    this.#names = {
      atoms: new SweatMap(options.quirksMode ? QUIRKS_NAME_OPTIONS : NAME_OPTIONS),
      prefixes: new SweatMap(NAME_OPTIONS),
      // Keyframes names are case-sensitive, even in quirks mode. They reach
      // four characters only after about 227,000 names, so they're never
      // `none` or a CSS-wide keyword.
      keyframes: new SweatMap(NAME_OPTIONS),
      // Part of the classes generated at runtime, so these follow class names.
      variables: new SweatMap(options.quirksMode ? QUIRKS_NAME_OPTIONS : NAME_OPTIONS),
    };
    this.#layer = layerRule(options.layer);
    const root = options.root ?? process.cwd();
    this.#root = root;
    this.#prepend = readPrepend(root, options.prependFiles);
    this.#libraries = (options.libraries ?? [])
      .map((library) => {
        const dir = resolvePath(root, library.dir);
        return {
          dir: dir + sep,
          prepend: readPrepend(dir, library.prependFiles),
          keyframeLocalization: library.keyframeLocalization ?? false,
          customPropertyLocalization: library.customPropertyLocalization ?? false,
        };
      })
      .toSorted((a, b) => b.dir.length - a.dir.length);
    this.#parseOptions = {
      lightningcss: options.lightningcss ?? {},
      sass,
      warn: options.warn ?? ((message) => console.warn(message)),
    };
  }

  // Increases whenever a class or global rule is added, so callers can tell
  // when the output CSS has changed.
  get revision(): number {
    return this.#order;
  }

  // Pass 1 of naming: parses a block and counts what it uses. Call for every
  // block before `assignNames`.
  scan(block: Block): void {
    const parsed = this.#parse(block);
    this.#register(block, parsed);
    this.#count(this.#resolveBlock(block, parsed, []));
    for (const global of parsed.globals) this.#countNames(global.key);
    for (const variable of parsed.variables ?? []) count(this.#counts.variables, variable.key);
  }

  // Pass 1 of naming for a stylesheet file: counts what each class uses.
  scanStylesheet(sheet: Stylesheet): void {
    const parsed = this.#parseSheet(sheet);
    for (const name of parsed.classes.keys())
      this.#count(this.#resolveClass(sheet.file, parsed, name, [], []));
    for (const global of parsed.globals) this.#countNames(global.key);
  }

  // Pass 2 of naming: gives the most-used entries the shortest names. Ties
  // are broken by key, so names don't depend on the order files are read.
  assignNames(): void {
    for (const list of ['atoms', 'prefixes', 'keyframes', 'variables'] as const) {
      const sorted = [...this.#counts[list]].toSorted(
        ([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0),
      );
      for (const [key] of sorted) this.#names[list].set(key);
    }
  }

  // The class string that replaces a block. Blocks that weren't scanned
  // (as in dev mode) are parsed and named on demand.
  classString(block: Block): string {
    const parsed = this.#parse(block);
    this.#register(block, parsed);
    return this.#classString(this.#resolveBlock(block, parsed, []));
  }

  // The variables a block sets at runtime, in the order they're written.
  variables(block: Block): BlockVariable[] {
    const parsed = this.#parse(block);
    this.#register(block, parsed);
    return (parsed.variables ?? []).map((variable) => {
      const name = this.#names.variables.set(variable.key);
      return {
        name,
        property: variable.property ? this.#propertyName(variable.property) : `--${name}`,
        slot: block.slots![variable.slot],
        selector: variable.selector,
      };
    });
  }

  // The files a block's class string depends on, through `composes … from`.
  dependencies(block: Block): string[] {
    const dependencies: string[] = [];
    this.#resolveBlock(block, this.#parse(block), dependencies);
    return [...new Set(dependencies)];
  }

  // The classes a stylesheet file exports, without compiling or keeping
  // anything, for tools that only need the names (such as the TypeScript
  // content mapper).
  classNames(sheet: Stylesheet): string[] {
    const { options } = this.#library(sheet.file);
    try {
      const parsed = parseStylesheet(
        sheet.code,
        sheet.lang,
        sheet.file,
        relative(this.#root, sheet.file),
        options,
      );
      return [...parsed.classes.keys()];
    } catch (error) {
      throw error instanceof PreStyleError ? locate(error, fileBlock(sheet.file)) : error;
    }
  }

  // Where each of the given classes is used, in output order. Classes that
  // aren't in the output are left out. Sources are only kept with `sourceMap`
  // on, and only list what has been compiled so far.
  usages(classNames: Iterable<string>): ClassUsage[] {
    const wanted = new Set(classNames);
    const usages: ClassUsage[] = [];
    let order = 0;
    const walk = (group: Group) => {
      for (const record of sortAtoms(group.atoms)) {
        order++;
        if (record.className !== null && wanted.has(record.className))
          usages.push(this.#usage(record, order));
      }
      for (const child of sortGroups([...group.children.values()])) walk(child);
    };
    walk(this.#atomGroups());
    return usages;
  }

  // Drops the places a file uses atoms, because it changed. They're added back
  // as its blocks are compiled again. The atoms stay, like the rest of dev's
  // output, which only grows.
  forgetSources(file: string): void {
    for (const record of this.#atoms.values())
      for (const [key, source] of record.sources)
        if (source.file === file) record.sources.delete(key);
  }

  // Each class of a stylesheet file, with its class string.
  stylesheet(sheet: Stylesheet): CompiledStylesheet {
    const parsed = this.#parseSheet(sheet);
    const dependencies = [...parsed.dependencies];
    const exports: CompiledStylesheet['exports'] = [];
    for (const name of parsed.classes.keys())
      exports.push([
        name,
        this.#classString(this.#resolveClass(sheet.file, parsed, name, [], dependencies)),
      ]);
    return { exports, dependencies: [...new Set(dependencies)] };
  }

  css(): Printed {
    const sources: string[] = [];
    const loc = (source: Source | null) => {
      if (source === null) return { source_index: 0, line: 0, column: 1 };
      let index = sources.indexOf(source.file);
      if (index === -1) index = sources.push(source.file) - 1;
      // Lightning CSS locations have lines from 0.
      return { source_index: index, line: source.line - 1, column: source.column };
    };

    const globals = [...this.#globals.values()].toSorted((a, b) => a.order - b.order);
    const hoisted = globals
      .filter((g) => g.global.hoist !== false)
      .toSorted((a, b) => (a.global.hoist as number) - (b.global.hoist as number));
    const rest = globals.filter((g) => g.global.hoist === false);
    const named = (g: GlobalRecord) =>
      withLoc(
        hasPlaceholder(g.global.key) ? this.#named(g.global.rule) : g.global.rule,
        loc(g.source),
      );
    let rules: Rule[] = [...hoisted, ...rest].map(named);
    rules.push(...this.#atomRules(loc));

    // `@import` and `@namespace` can't be inside a layer, so they stay
    // before it. `@layer` statements go inside, so the layers they order
    // are the same ones blocks' `@layer` rules add to.
    if (this.#layer !== null) {
      rules = [
        ...rules.filter(outside),
        {
          type: 'layer-block',
          value: {
            ...valueOf(this.#layer),
            rules: rules.filter((r) => !outside(r)),
            loc: loc(null),
          },
        } as Rule,
      ];
    }

    return print(rules, sources, this.#parseOptions.lightningcss, this.#options.sourceMap ?? false);
  }

  // Classes on the element have an empty prefix.
  cnTable(): CnTable {
    const table: CnTable = {};
    for (const record of this.#atoms.values()) {
      const key = prefixKey(record.atom);
      const prefix = key === '' ? '' : this.#names.prefixes.set(key);
      const properties = (table[prefix] ??= {});
      const property = this.#propertyName(record.atom.property);
      const name = this.#nameOf(record);
      properties[property] = properties[property] ? `${properties[property]} ${name}` : name;
    }
    return table;
  }

  // The variables runtime values set, for `cn` to recognize generated classes.
  cnVariables(): CnVariables {
    const variables: CnVariables = {};
    for (const [key, property] of this.#variables)
      variables[this.#names.variables.set(key)] = property ? this.#propertyName(property) : '';
    return variables;
  }

  // A library's blocks and files get its prepended files and keyframes
  // setting instead of the app's.
  #library(file: string | undefined): { library: number; options: ParseOptions } {
    const library =
      file === undefined ? -1 : this.#libraries.findIndex(({ dir }) => file.startsWith(dir));
    const { prepend, keyframeLocalization, customPropertyLocalization } =
      library === -1
        ? {
            prepend: this.#prepend,
            keyframeLocalization: this.#options.keyframeLocalization,
            customPropertyLocalization: this.#options.customPropertyLocalization,
          }
        : this.#libraries[library];
    return {
      library,
      options: {
        ...this.#parseOptions,
        prepend,
        keyframeLocalization: keyframeLocalization ?? false,
        customPropertyLocalization: customPropertyLocalization ?? false,
      },
    };
  }

  #parse(block: Block): ParsedBlock {
    const { library, options } = this.#library(block.file);
    const cacheKey = `${library}\n${block.lang}\n${block.code}`;
    let parsed = this.#blocks.get(cacheKey);
    if (parsed === undefined) {
      try {
        parsed = parseBlock(block.code, block.lang, options);
      } catch (error) {
        throw error instanceof PreStyleError ? locate(error, block) : error;
      }
      this.#blocks.set(cacheKey, parsed);
    }
    return parsed;
  }

  // Parses a stylesheet file and registers its classes and global rules, so
  // the output includes them once the file is used.
  #parseSheet(sheet: Stylesheet): ParsedStylesheet {
    const { library, options } = this.#library(sheet.file);
    const cacheKey = `${library}\n${sheet.lang}\n${sheet.file}\n${sheet.code}`;
    let parsed = this.#stylesheets.get(cacheKey);
    if (parsed === undefined) {
      try {
        parsed = parseStylesheet(
          sheet.code,
          sheet.lang,
          sheet.file,
          relative(this.#root, sheet.file),
          options,
        );
      } catch (error) {
        throw error instanceof PreStyleError ? locate(error, fileBlock(sheet.file)) : error;
      }
      this.#stylesheets.set(cacheKey, parsed);
    }
    const block = fileBlock(sheet.file);
    for (const target of parsed.classes.values())
      this.#register(block, { atoms: target.atoms, globals: [], composes: [] });
    this.#register(block, { atoms: [], globals: parsed.globals, composes: [] });
    return parsed;
  }

  // Reads a file named by `composes … from`.
  #readSheet(file: string): ParsedStylesheet {
    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch (error) {
      throw new PreStyleError(`Can't read ${file}, named by \`composes\`.`, null, { cause: error });
    }
    return this.#parseSheet({ code, lang: file.endsWith('.scss') ? 'scss' : 'css', file });
  }

  // A class's atoms and other names, after its `composes`. Composed atoms
  // come first, so the class's own declarations replace the ones they
  // conflict with, as in `cn`. `stack` holds the classes being resolved, to
  // find cycles. Files composed from are added to `dependencies`.
  #resolveClass(
    file: string,
    parsed: ParsedStylesheet,
    name: string,
    stack: string[],
    dependencies: string[],
  ): Resolved {
    const target = parsed.classes.get(name);
    if (target === undefined)
      throw new PreStyleError(`${file} has no class \`${name}\` to compose.`, null);
    const id = `${file}\0${name}`;
    if (stack.includes(id))
      throw new PreStyleError(
        `\`composes\` cycle: ${[...stack, id].map((entry) => entry.replace('\0', ' .')).join(' -> ')}.`,
        null,
      );
    const composed = this.#resolveComposes(
      file,
      parsed,
      target.composes,
      [...stack, id],
      dependencies,
    );
    if (target.marker) composed.extras.push(markerKey(relative(this.#root, file), name));
    return {
      atoms:
        composed.atoms.length === 0
          ? target.atoms
          : dropOverridden([...composed.atoms, ...target.atoms]),
      extras: composed.extras,
    };
  }

  #resolveBlock(block: Block, parsed: ParsedBlock, dependencies: string[]): Resolved {
    if (parsed.composes.length === 0) return { atoms: parsed.atoms, extras: [] };
    for (const c of parsed.composes) {
      if (c.from.type === 'local')
        throw new PreStyleError(
          'Blocks have no classes of their own to compose. Use `composes: a from "./file.css";` or `composes: a from global;`.',
          c.position,
        );
    }
    const file = block.file ?? resolvePath(this.#root, 'block.css');
    let composed: Resolved;
    try {
      composed = this.#resolveComposes(file, null, parsed.composes, [], dependencies);
    } catch (error) {
      throw error instanceof PreStyleError ? locate(error, block) : error;
    }
    return { atoms: dropOverridden([...composed.atoms, ...parsed.atoms]), extras: composed.extras };
  }

  #resolveComposes(
    file: string,
    parsed: ParsedStylesheet | null,
    composes: Compose[],
    stack: string[],
    dependencies: string[],
  ): Resolved {
    const atoms: Atom[] = [];
    const extras: string[] = [];
    for (const c of composes) {
      if (c.from.type === 'global') {
        extras.push(...c.names);
        continue;
      }
      let from = file;
      let sheet = parsed!;
      if (c.from.type === 'file') {
        from = resolvePath(dirname(file), c.from.path);
        dependencies.push(from);
        sheet = this.#readSheet(from);
        dependencies.push(...sheet.dependencies);
      }
      for (const name of c.names) {
        const resolved = this.#resolveClass(from, sheet, name, stack, dependencies);
        atoms.push(...resolved.atoms);
        extras.push(...resolved.extras);
      }
    }
    return { atoms, extras };
  }

  #count(resolved: Resolved) {
    for (const atom of resolved.atoms) {
      count(this.#counts.atoms, atomKey(atom));
      const prefix = prefixKey(atom);
      if (prefix !== '') count(this.#counts.prefixes, prefix);
      this.#countNames(atom.declaration.key);
    }
    for (const extra of resolved.extras)
      if (extra.startsWith(MARKER_PREFIX)) count(this.#counts.atoms, extra);
  }

  #classString(resolved: Resolved): string {
    const names = resolved.atoms.map((atom) => this.#nameOf(this.#atoms.get(atomKey(atom))!));
    for (const extra of resolved.extras)
      names.push(extra.startsWith(MARKER_PREFIX) ? this.#names.atoms.set(extra) : extra);
    return [...new Set(names)].join(' ');
  }

  // Counts the localized keyframes and custom properties a JSON key names.
  #countNames(json: string) {
    if (json.includes(KEYFRAMES_KEY))
      for (const [, hash] of json.matchAll(KEYFRAMES_KEY_RE))
        count(this.#counts.keyframes, KEYFRAMES_PREFIX + hash);
    if (json.includes(VARIABLE_KEY))
      for (const [, hash] of json.matchAll(VARIABLE_KEY_RE)) count(this.#counts.variables, hash);
  }

  // A property's name in the output, for a custom property with a generated one.
  #propertyName(property: string): string {
    return property.startsWith(VARIABLE_PREFIX) ? (this.#named(property) as string) : property;
  }

  // Replaces markers in selectors, and localized keyframes names, with their
  // names.
  #named<T>(value: T): T {
    const visit = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(visit);
      if (typeof node === 'string' && node.startsWith(VARIABLE_PREFIX))
        return `--${this.#names.variables.set(node.slice(VARIABLE_PREFIX.length))}`;
      if (node === null || typeof node !== 'object') return node;
      const record = node as Record<string, unknown>;
      if (
        record.type === 'class' &&
        typeof record.name === 'string' &&
        record.name.startsWith(MARKER_PREFIX)
      )
        return { ...record, name: this.#names.atoms.set(record.name) };
      if (
        record.type === 'ident' &&
        typeof record.value === 'string' &&
        record.value.startsWith(KEYFRAMES_PREFIX)
      )
        return { ...record, value: this.#names.keyframes.set(record.value) };
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, visit(v)]));
    };
    return visit(value) as T;
  }

  #register(block: Block, parsed: ParsedBlock) {
    for (const variable of parsed.variables ?? []) {
      if (this.#variables.has(variable.key)) continue;
      this.#variables.set(variable.key, variable.property);
      // A custom property set directly adds no atom or rule, but `cn` needs it.
      this.#order++;
    }
    for (const atom of parsed.atoms) {
      const key = atomKey(atom);
      const source = sourceOf(block, atom.position);
      let record = this.#atoms.get(key);
      if (record === undefined) {
        record = {
          atom,
          className: null,
          order: this.#order++,
          source,
          sources: new Map(),
          printed: null,
        };
        this.#atoms.set(key, record);
      }
      if (source !== null && this.#options.sourceMap)
        record.sources.set(`${source.file}:${source.line}:${source.column}`, source);
    }
    for (const global of parsed.globals) {
      if (this.#globals.has(global.key)) continue;
      // Only the last definition of an overridable at-rule is kept.
      if (global.overrideKey !== null) {
        const previous = this.#overrides.get(global.overrideKey);
        if (previous !== undefined) this.#globals.delete(previous);
        this.#overrides.set(global.overrideKey, global.key);
      }
      this.#globals.set(global.key, {
        global,
        order: this.#order++,
        source: sourceOf(block, global.position),
      });
    }
  }

  #nameOf(record: AtomRecord): string {
    return (record.className ??= this.#names.atoms.set(atomKey(record.atom)));
  }

  // Atoms grouped by their at-rules, nesting groups the same way.
  #atomGroups(): Group {
    const root: Group = { segment: null, order: 0, atoms: [], children: new Map() };
    for (const record of this.#atoms.values()) {
      let group = root;
      for (const segment of record.atom.atRules) {
        let child = group.children.get(segment.key);
        if (child === undefined) {
          child = { segment, order: record.order, atoms: [], children: new Map() };
          group.children.set(segment.key, child);
        }
        group = child;
      }
      group.atoms.push(record);
    }
    return root;
  }

  #atomSelectors(record: AtomRecord): SelectorList {
    const { atom } = record;
    const className = this.#nameOf(record);
    const selectors: SelectorList = atom.variant
      ? withClass(atom.variant.selectors, className)
      : [[{ type: 'class', name: className }]];
    return atom.variant?.key.includes(MARKER_KEY) ? this.#named(selectors) : selectors;
  }

  #atomRule(record: AtomRecord, loc: unknown): Rule {
    const { atom } = record;
    const value = hasGenerated(atom.declaration.key)
      ? this.#named(atom.declaration.value)
      : atom.declaration.value;
    const declarations = atom.declaration.important
      ? { importantDeclarations: [value] }
      : { declarations: [value] };
    return {
      type: 'style',
      value: { selectors: this.#atomSelectors(record), declarations, rules: [], loc },
    } as Rule;
  }

  #atomRules(loc: (source: Source | null) => unknown): Rule[] {
    const emit = (group: Group): Rule[] => {
      const rules: Rule[] = sortAtoms(group.atoms).map((record) => {
        // The first place it's still used, since `forgetSources` drops places.
        const [source = record.source] = record.sources.values();
        return this.#atomRule(record, loc(source));
      });
      for (const child of sortGroups([...group.children.values()])) {
        const segment = child.segment!;
        const named = hasGenerated(segment.key) ? this.#named(segment.rule) : segment.rule;
        rules.push({
          type: segment.rule.type,
          value: { ...valueOf(named), rules: emit(child) },
        } as Rule);
      }
      return rules;
    };
    return emit(this.#atomGroups());
  }

  #usage(record: AtomRecord, order: number): ClassUsage {
    const { atom } = record;
    const loc = { source_index: 0, line: 0, column: 1 };
    const rule = this.#atomRule(record, loc);
    // Printed for reading, so without the user's `minify` and `targets`.
    const { drafts, nonStandard, errorRecovery } = this.#parseOptions.lightningcss;
    const text = (rules: Rule) =>
      print([rules], [], { drafts, nonStandard, errorRecovery }, false).code;
    const code = (record.printed ??= text(rule));
    const open = code.indexOf(' {\n');
    return {
      className: record.className!,
      selector: code.slice(0, open).replaceAll('\n', ' '),
      atRules: atom.atRules.map((segment) => {
        const named = hasGenerated(segment.key) ? this.#named(segment.rule) : segment.rule;
        const wrapped = { ...valueOf(named), rules: [rule] };
        const printed = text({ type: segment.rule.type, value: wrapped } as Rule);
        return printed.slice(0, printed.indexOf(' {\n'));
      }),
      declaration: code
        .slice(open + 3, code.lastIndexOf('\n}'))
        .trim()
        .replace(/;$/, ''),
      property: this.#propertyName(atom.property),
      covers: Object.hasOwn(SHORTHANDS, atom.property) ? SHORTHANDS[atom.property] : [],
      important: atom.declaration.important,
      specificity: specificity(this.#atomSelectors(record)),
      order,
      sources: [...record.sources.values()],
    };
  }
}

interface Group {
  segment: AtRuleSegment | null;
  order: number;
  atoms: AtomRecord[];
  children: Map<string, Group>;
}

// Markers and localized keyframes names as they appear in JSON keys, which
// escape the `\0`.
const MARKER_KEY = JSON.stringify(MARKER_PREFIX).slice(1, -1);
const KEYFRAMES_KEY = JSON.stringify(KEYFRAMES_PREFIX).slice(1, -1);
const VARIABLE_KEY = JSON.stringify(VARIABLE_PREFIX).slice(1, -1);
const VARIABLE_KEY_RE = new RegExp(`${RegExp.escape(VARIABLE_KEY)}([\\w-]+)`, 'g');
const KEYFRAMES_KEY_RE = new RegExp(`${RegExp.escape(KEYFRAMES_KEY)}([\\w-]+)`, 'g');

// Rules that can't be inside a layer.
const outside = (rule: Rule) => rule.type === 'import' || rule.type === 'namespace';

// Whether a declaration has generated names.
const hasGenerated = (json: string) => json.includes(KEYFRAMES_KEY) || json.includes(VARIABLE_KEY);

const hasPlaceholder = (json: string) => json.includes(MARKER_KEY) || hasGenerated(json);

// Parses the `layer` option into an `@layer` block rule.
function layerRule(layer: false | string | undefined): Rule | null {
  if (layer === undefined || layer === false) return null;
  if (typeof layer !== 'string')
    throw new PreStyleError('`layer` must be `false` or a string.', null);
  let rule: Rule | undefined;
  try {
    transform({
      filename: 'layer.css',
      code: Buffer.from(`@layer ${layer} {}`),
      visitor: {
        StyleSheetExit(sheet) {
          if (sheet.rules.length === 1) rule = sheet.rules[0];
        },
      },
    });
  } catch {
    // Reported below.
  }
  if (rule?.type !== 'layer-block' || (layer.trim() === '') !== (rule.value.name == null))
    throw new PreStyleError(
      `\`layer\` must be a layer name, such as "pre.style" or "base.components", or "" for an unnamed layer. Got ${JSON.stringify(layer)}.`,
      null,
    );
  return rule;
}

// A stylesheet file, for positions and source maps.
const fileBlock = (file: string): Block => ({ code: '', lang: 'css', file, line: 1, column: 1 });

// Reads prepended files, relative to `dir`, once.
function readPrepend(dir: string, files: PrependFiles | undefined): Record<Lang, string> {
  const read = (list: string[] = []) =>
    list.map((file) => readFileSync(resolvePath(dir, file), 'utf8')).join('\n');
  return Array.isArray(files)
    ? { css: read(files), scss: read(files) }
    : { css: read(files?.css), scss: read(files?.scss) };
}

const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

// The at-rules and selector variant an atom is under. Empty for atoms on the
// element.
const prefixKey = (atom: Atom) =>
  atom.atRules.length === 0 && !atom.variant
    ? ''
    : `${atom.atRules.map((s) => s.key).join('\n')}\n${atom.variant?.key ?? ''}`;

const atomKey = (atom: Atom) => `${prefixKey(atom)}\n${atom.declaration.key}`;

// Base classes, then selector variant classes in LVHFA order. Within each,
// shorthands that couldn't be expanded come first, so the longhands after
// them win, then classes keep the order they first appeared in.
function sortAtoms(atoms: AtomRecord[]): AtomRecord[] {
  const rank = (record: AtomRecord) =>
    record.atom.variant ? lvhfaRank(record.atom.variant.selectors) : -2;
  return atoms.toSorted(
    (a, b) =>
      rank(a) - rank(b) || Number(b.atom.shorthand) - Number(a.atom.shorthand) || a.order - b.order,
  );
}

// At-rule groups keep the order they first appeared in, except `@media`
// queries with only a `min-width`, which come last, smallest first
// (mobile-first).
function sortGroups(groups: Group[]): Group[] {
  const width = (group: Group) => minWidth(group.segment!.rule);
  return groups.toSorted((a, b) => {
    const wa = width(a);
    const wb = width(b);
    if (wa === null || wb === null)
      return wa === null && wb === null ? a.order - b.order : wa === null ? -1 : 1;
    return wa - wb || a.order - b.order;
  });
}

const UNIT_PX: Record<string, number> = { px: 1, em: 16, rem: 16 };

// The `min-width` of a `@media` rule with a single `min-width` query, in px.
function minWidth(rule: Rule): number | null {
  if (rule.type !== 'media') return null;
  const queries = rule.value.query.mediaQueries;
  if (queries.length !== 1) return null;
  const { qualifier, mediaType, condition } = queries[0];
  if (qualifier || mediaType !== 'all' || condition?.type !== 'feature') return null;
  const feature = condition.value as any;
  const isMin =
    (feature.type === 'range' &&
      feature.name === 'width' &&
      feature.operator === 'greater-than-equal') ||
    (feature.type === 'plain' && feature.name === 'min-width');
  const length = feature.value?.type === 'length' ? feature.value.value : null;
  if (!isMin || length?.type !== 'value' || !(length.value.unit in UNIT_PX)) return null;
  return length.value.value * UNIT_PX[length.value.unit];
}

function withLoc(rule: Rule, loc: unknown): Rule {
  const value = valueOf(rule);
  return value.loc === undefined ? rule : ({ ...rule, value: { ...value, loc } } as Rule);
}

function sourceOf(block: Block, position: Position | null): Source | null {
  if (block.file === undefined) return null;
  return absolute(block, position ?? { line: 0, column: 1 });
}

// Converts a position in a block to its file.
function absolute(block: Block, position: Position): Source {
  const line = block.line ?? 1;
  const column = block.column ?? 1;
  return {
    file: block.file ?? '',
    line: line + position.line,
    column: position.line === 0 ? column + position.column - 1 : position.column,
  };
}

function locate(error: PreStyleError, block: Block): PreStyleError {
  if (block.file === undefined) return error;
  const source = absolute(block, error.position ?? { line: 0, column: 1 });
  return new PreStyleError(
    `${source.file}:${source.line}:${source.column}: ${error.message}`,
    error.position,
    { cause: error.cause },
  );
}
