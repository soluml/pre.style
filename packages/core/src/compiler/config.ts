import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrependFiles } from './compiler.ts';
import type { LibraryConfig } from './libraries.ts';

// The `pre.style` field in the app's package.json: the options every tool
// that reads the project's styles agrees on.
export interface PackageConfig {
  // Globs of every source file that contains blocks, relative to the
  // package. Scanned before the build to assign stable names.
  include?: string | string[];
  // Globs removed from `include`.
  exclude?: string | string[];
  // Files prepended to the app's blocks and stylesheet files: an array for
  // both languages, or separate arrays for css and scss. Relative to the
  // package.
  prependFiles?: PrependFiles;
  // Component libraries to compile, by package name, in addition to the
  // dependencies with a `pre.style` field. A config replaces the package's
  // field, and `false` leaves the package out.
  libraries?: Record<string, LibraryConfig | boolean>;
  // Lowercase class names only, for pages in quirks mode (no doctype).
  quirksMode?: boolean;
  // Give each `@keyframes` in the app's blocks and stylesheet files a
  // generated name, used only in its own block or file.
  keyframeLocalization?: boolean;
  customPropertyLocalization?: boolean;
}

const KEYS = new Set([
  'include',
  'exclude',
  'prependFiles',
  'libraries',
  'quirksMode',
  'keyframeLocalization',
  'customPropertyLocalization',
]);

const isStrings = (value: unknown) =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'));

const isPrependFiles = (value: unknown) =>
  (Array.isArray(value) && isStrings(value)) ||
  (value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([lang, files]) =>
        (lang === 'css' || lang === 'scss') && Array.isArray(files) && isStrings(files),
    ));

// Checks a `pre.style` field's shared keys, and returns warnings for keys
// it doesn't know. `where` names the field in errors.
export function checkField(
  field: Record<string, unknown>,
  where: string,
  keys: Set<string>,
): string[] {
  const fail = (key: string, expected: string) => {
    throw new Error(`[pre.style] ${where}: \`${key}\` must be ${expected}.`);
  };
  if (field.include !== undefined && !isStrings(field.include))
    fail('include', 'a glob or an array of globs');
  if (field.exclude !== undefined && !isStrings(field.exclude))
    fail('exclude', 'a glob or an array of globs');
  if (field.prependFiles !== undefined && !isPrependFiles(field.prependFiles))
    fail('prependFiles', 'an array of paths, or an object with `css` and `scss` arrays');
  if (field.quirksMode !== undefined && typeof field.quirksMode !== 'boolean')
    fail('quirksMode', '`true` or `false`');
  if (field.keyframeLocalization !== undefined && typeof field.keyframeLocalization !== 'boolean')
    fail('keyframeLocalization', '`true` or `false`');
  if (
    field.customPropertyLocalization !== undefined &&
    typeof field.customPropertyLocalization !== 'boolean'
  )
    fail('customPropertyLocalization', '`true` or `false`');
  if (
    field.libraries !== undefined &&
    (field.libraries === null ||
      typeof field.libraries !== 'object' ||
      Array.isArray(field.libraries))
  )
    fail('libraries', 'an object of package names');
  return Object.keys(field)
    .filter((key) => !keys.has(key))
    .map((key) => `${where}: unknown key \`${key}\`.`);
}

// Reads the `pre.style` field from the package.json nearest `root`. `dir`
// is the package's directory, which the field's paths are relative to.
export function readConfig(root: string): {
  dir: string;
  config: PackageConfig;
  warnings: string[];
} {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const field: unknown = JSON.parse(readFileSync(file, 'utf8'))['pre.style'];
      if (field === undefined) return { dir, config: {}, warnings: [] };
      const where = `"pre.style" in ${file}`;
      if (field === null || typeof field !== 'object' || Array.isArray(field))
        throw new Error(`[pre.style] ${where} must be an object.`);
      const warnings = checkField(field as Record<string, unknown>, where, KEYS);
      return { dir, config: field as PackageConfig, warnings };
    }
    if (dirname(dir) === dir) return { dir: root, config: {}, warnings: [] };
  }
}
