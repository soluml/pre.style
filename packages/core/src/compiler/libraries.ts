import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrependFiles } from './compiler.ts';
import { checkField } from './config.ts';

// How a component library is compiled, from the `pre.style` field in its
// package.json or the app's `libraries` setting.
export interface LibraryConfig {
  // Globs of the library's files that contain blocks, relative to the
  // package. Defaults to every JS, TS, and Astro file.
  include?: string | string[];
  // Globs removed from `include`.
  exclude?: string | string[];
  // Prepended to the library's blocks only. Relative to the package.
  prependFiles?: PrependFiles;
  // Localize the library's keyframes. The app's setting doesn't apply to
  // libraries, since a library's styles are written for its own.
  keyframeLocalization?: boolean;
  customPropertyLocalization?: boolean;
}

export interface ResolvedLibrary {
  name: string;
  // The package's real path, with symlinks resolved, as Vite sees its files.
  dir: string;
  include: string[];
  exclude: string[];
  prependFiles?: PrependFiles;
  keyframeLocalization?: boolean;
  customPropertyLocalization?: boolean;
}

// Keys a library's field shares with the app's. `libraries` and
// `quirksMode` only apply to the app.
const SHARED_KEYS = new Set([
  'include',
  'exclude',
  'prependFiles',
  'keyframeLocalization',
  'customPropertyLocalization',
]);
const APP_KEYS = new Set(['libraries', 'quirksMode']);

const DEFAULT_INCLUDE = ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,astro}'];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  'pre.style'?: LibraryConfig | boolean;
}

const readPackage = (dir: string): PackageJson =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

// Finds an installed package the way Node does, by looking in each
// `node_modules` up from `from`.
function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

// Finds the pre.style component libraries an app uses: its dependencies
// with a `pre.style` field, and theirs, recursively. `overrides` adds
// packages, changes their config, or (with `false`) leaves them out.
// `warn` receives problems that don't stop the build.
export function findLibraries(
  root: string,
  overrides: Record<string, LibraryConfig | boolean> = {},
  warn: (message: string) => void = () => {},
): ResolvedLibrary[] {
  const libraries: ResolvedLibrary[] = [];
  const seen = new Set<string>();

  const visit = (name: string, from: string) => {
    const dir = findPackage(name, from);
    if (dir === null || seen.has(dir)) return;
    seen.add(dir);
    const pkg = readPackage(dir);
    const config = Object.hasOwn(overrides, name) ? overrides[name] : pkg['pre.style'];
    if (!config) return;
    if (config !== true) {
      const where = Object.hasOwn(overrides, name)
        ? `"libraries" entry for ${name}`
        : `"pre.style" in ${join(dir, 'package.json')}`;
      for (const key of Object.keys(config))
        if (APP_KEYS.has(key))
          warn(`${where}: \`${key}\` only applies to the app, so it's ignored for a library.`);
      for (const warning of checkField(
        config as Record<string, unknown>,
        where,
        new Set([...SHARED_KEYS, ...APP_KEYS]),
      ))
        warn(warning);
    }
    const { include, exclude, prependFiles, keyframeLocalization, customPropertyLocalization } =
      config === true ? {} : config;
    libraries.push({
      name,
      dir,
      include: include === undefined ? DEFAULT_INCLUDE : [include].flat(),
      exclude: exclude === undefined ? [] : [exclude].flat(),
      prependFiles,
      keyframeLocalization,
      customPropertyLocalization,
    });
    // A library's peer dependencies are installed by the app, and found the
    // same way from the library.
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    })) {
      visit(dependency, dir);
    }
  };

  const app = existsSync(join(root, 'package.json')) ? readPackage(root) : {};
  const names = Object.keys({
    ...app.dependencies,
    ...app.devDependencies,
    ...app.optionalDependencies,
    ...overrides,
  });
  for (const name of names) visit(name, root);
  return libraries;
}
