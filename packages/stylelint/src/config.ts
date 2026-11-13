import { extname, isAbsolute, resolve } from 'node:path';
import postcssScss from 'postcss-scss';
import type { Config } from 'stylelint';
import { findLibraries, readConfig, type PrependFiles } from '@pre.style/core/compiler';

type Override = NonNullable<Config['overrides']>[number];
type ReferenceFiles = Exclude<NonNullable<Config['referenceFiles']>, string | unknown[]>;

export interface PrependOptions {
  // The apps (or libraries) whose files are linted, as directories. Each
  // one's `pre.style` field is read from its nearest package.json. Defaults
  // to the current directory.
  packages?: string[];
  // Your own `referenceFiles`, kept for every package: an override's
  // `referenceFiles` replaces the config's.
  referenceFiles?: Config['referenceFiles'];
  // Receives problems that don't stop linting, such as unknown keys in a
  // library's field.
  warn?: (message: string) => void;
}

// A path as a glob that matches only it: Stylelint globs override and
// reference file paths.
const literal = (path: string) => path.replaceAll('\\', '/').replace(/[*?[\]{}()!+@]/g, '\\$&');

// The files a package prepends, for either language.
function prependedFiles(dir: string, prependFiles: PrependFiles | undefined): string[] {
  if (prependFiles === undefined) return [];
  const files = Array.isArray(prependFiles)
    ? prependFiles
    : [...(prependFiles.css ?? []), ...(prependFiles.scss ?? [])];
  return [...new Set(files.map((file) => (isAbsolute(file) ? file : resolve(dir, file))))];
}

// Stylelint's `referenceFiles` for prepended files: `.scss` files are read
// with the scss syntax. Reference files aren't linted, but rules that look
// for declared names (custom properties, keyframes, custom media) see them.
function referenceFiles(files: string[]): (string | ReferenceFiles)[] {
  const css = files.filter((file) => extname(file) !== '.scss');
  const scss = files.filter((file) => extname(file) === '.scss');
  return [
    ...(css.length > 0 ? [{ files: css.map(literal) }] : []),
    ...(scss.length > 0 ? [{ files: scss.map(literal), customSyntax: postcssScss }] : []),
  ];
}

// An override per package (each app, and each library it uses) that gives
// the package's files its own prepended files as `referenceFiles`, as the
// build prepends each package's own. Libraries come after apps, so a
// library inside an app's directory gets its own, even when it has none.
export function prependOverrides({
  packages = [process.cwd()],
  referenceFiles: own,
  warn = (message) => process.emitWarning(message, { type: 'pre.style' }),
}: PrependOptions = {}): Override[] {
  const seen = new Set<string>();
  const apps: Override[] = [];
  const libraries: Override[] = [];
  const kept = own === undefined ? [] : [own].flat();
  const add = (list: Override[], dir: string, prependFiles: PrependFiles | undefined) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const files = prependedFiles(dir, prependFiles);
    if (files.length === 0 && list === apps) return;
    list.push({
      files: [`${literal(dir)}/**`],
      referenceFiles: [...kept, ...referenceFiles(files)],
    });
  };
  for (const root of packages) {
    const app = readConfig(resolve(root));
    for (const warning of app.warnings) warn(warning);
    add(apps, app.dir, app.config.prependFiles);
    for (const library of findLibraries(app.dir, app.config.libraries, warn))
      add(libraries, library.dir, library.prependFiles);
  }
  return [...apps, ...libraries];
}
