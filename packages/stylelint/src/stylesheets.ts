import { globSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { findInScript, SHEET_IMPORT } from '@pre.style/core/find';
import { readConfig } from '@pre.style/core/compiler';
import { fileKind } from './blocks.ts';

// Files that can import stylesheets, when the field has no `include`. HTML
// can't import anything.
const DEFAULT_INCLUDE = ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,astro}'];
const NODE_MODULES = '**/node_modules/**';
// How long a package's index is trusted before files are checked again, so
// one lint run scans once and an editor sees new imports soon after.
const REVALIDATE_MS = 1000;

// `composes: a from './file.css'`, in a block or a stylesheet file.
const COMPOSES_FROM = /\bcomposes\s*:[^;`}]*?\bfrom\s*(['"])([^'"]+)\1/g;

// Resolves a specifier the way Node does: relative to the importer, or as a
// package. Aliases a bundler adds aren't known, so they're null.
function resolveSpecifier(specifier: string, importer: string): string | null {
  if (specifier.startsWith('.') || isAbsolute(specifier))
    return resolve(dirname(importer), specifier);
  try {
    return createRequire(importer).resolve(specifier);
  } catch {
    return null;
  }
}

// The stylesheets a file names: its `with { type: 'pre.style' }` imports
// and the files its blocks compose from (or, for a stylesheet, the files it
// composes from).
export function namedStylesheets(file: string, code: string): string[] {
  const specifiers: string[] = [];
  if (code.includes('pre.style')) {
    const kind = fileKind(file);
    if (kind === 'script') {
      try {
        specifiers.push(
          ...(findInScript(file, code, [])?.sheets.map(({ specifier }) => specifier) ?? []),
        );
      } catch {
        // A file that doesn't parse names nothing.
      }
    } else if (kind === 'component')
      specifiers.push(...[...code.matchAll(SHEET_IMPORT)].map((match) => match[2]));
  }
  if (code.includes('composes'))
    specifiers.push(...[...code.matchAll(COMPOSES_FROM)].map((match) => match[2]));
  return specifiers
    .map((specifier) => resolveSpecifier(specifier, file))
    .filter((path): path is string => path !== null && /\.s?css$/.test(extname(path)));
}

interface Scanned {
  stamp: string;
  names: string[];
}

const stamp = (file: string) => {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${mtimeMs}:${size}`;
  } catch {
    return null;
  }
};

// The stylesheets a package's files import, and the ones those compose from.
class PackageIndex {
  readonly #dir: string;
  readonly #include: string[];
  readonly #exclude: string[];
  readonly #scanned = new Map<string, Scanned>();
  #sheets = new Set<string>();
  #checked = -Infinity;

  constructor(dir: string, include: string[], exclude: string[]) {
    this.#dir = dir;
    this.#include = include;
    this.#exclude = exclude;
  }

  // What a file names, read again only when it changed.
  #names(file: string): string[] {
    const current = stamp(file);
    if (current === null) return [];
    const cached = this.#scanned.get(file);
    if (cached?.stamp === current) return cached.names;
    const names = namedStylesheets(file, readFileSync(file, 'utf8'));
    this.#scanned.set(file, { stamp: current, names });
    return names;
  }

  stylesheets(now = Date.now()): Set<string> {
    if (now - this.#checked < REVALIDATE_MS) return this.#sheets;
    this.#checked = now;
    const sheets = new Set<string>();
    const pending: string[] = [];
    for (const file of globSync(this.#include, { cwd: this.#dir, exclude: this.#exclude }))
      pending.push(...this.#names(resolve(this.#dir, file)));
    // Stylesheets name more through `composes … from`.
    while (pending.length > 0) {
      const sheet = pending.pop()!;
      if (sheets.has(sheet)) continue;
      sheets.add(sheet);
      pending.push(...this.#names(sheet));
    }
    this.#sheets = sheets;
    return sheets;
  }
}

const indexes = new Map<string, PackageIndex>();

// The index of the package a file belongs to: the nearest package.json, and
// its `pre.style` field's `include` and `exclude`.
function indexFor(file: string): PackageIndex {
  const { dir, config } = readConfig(dirname(file));
  let index = indexes.get(dir);
  if (index === undefined) {
    index = new PackageIndex(
      dir,
      config.include === undefined ? DEFAULT_INCLUDE : [config.include].flat(),
      [...(config.exclude === undefined ? [] : [config.exclude].flat()), NODE_MODULES],
    );
    indexes.set(dir, index);
  }
  return index;
}

// Whether a `.css` or `.scss` file is a pre.style stylesheet: imported with
// `with { type: 'pre.style' }` by a file in its package, or composed from by
// one. A library's stylesheet that only an app imports is found once the
// app's index exists, which linting any of the app's stylesheets builds.
// Other CSS is ordinary global CSS.
export function isStylesheet(file: string): boolean {
  const path = resolve(file);
  const own = indexFor(path);
  if (own.stylesheets().has(path)) return true;
  for (const index of indexes.values())
    if (index !== own && index.stylesheets().has(path)) return true;
  return false;
}

// Forgets every package's index, for tests.
export function clearStylesheetIndexes(): void {
  indexes.clear();
}
