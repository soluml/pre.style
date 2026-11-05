import type { CnLookup } from './cn.ts';

// What the bundler plugin passes for each variable a block sets: its short
// name, the text around its values, which of the block's values they are (as
// `~index` for a value in a quoted string, which has to be escaped), and
// the custom property it sets, when that isn't `--<name>`, and where to set it,
// split where the class goes, when that isn't the element.
export type RuntimeVariable = [
  name: string,
  strings: readonly string[],
  indexes: readonly number[],
  property?: string | 0,
  selector?: readonly string[],
];

const DIGITS = '0123456789';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
export const CASE_SENSITIVE = DIGITS + LOWERCASE + LOWERCASE.toUpperCase();
export const CASE_INSENSITIVE = DIGITS + LOWERCASE;
const HASH_LENGTH = 4;

// A hash of a value that's the same on the server and in the browser, since
// the class names it's part of have to match for hydration. FNV-1a.
function hash(value: string, alphabet: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  let result = '';
  for (let i = 0; i < HASH_LENGTH; i++) {
    result += alphabet[h % alphabet.length];
    h = Math.floor(h / alphabet.length);
  }
  return result;
}

// What can't be written as it is in a quoted CSS string.
const UNSAFE_IN_STRING = /["'\\\n\r\f]/g;

// Reports a value that isn't a string, a finite number, null, or undefined.
export type InvalidValue = (value: unknown, strings: readonly string[]) => never;

// The variable's value, or null when any of its values is null or undefined,
// so its default applies. Anything else is almost always a bug, which falling
// back would hide.
function text(
  strings: readonly string[],
  indexes: readonly number[],
  values: readonly unknown[],
  invalid: InvalidValue,
): string | null {
  let result = strings[0];
  let missing = false;
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i];
    const value = values[index < 0 ? ~index : index];
    if (value === null || value === undefined) missing = true;
    else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      result +=
        (index < 0
          ? String(value).replace(UNSAFE_IN_STRING, (c) => `\\${c.charCodeAt(0).toString(16)} `)
          : value) + strings[i + 1];
    else invalid(value, strings);
  }
  return missing ? null : result;
}

let sheet: CSSStyleSheet | undefined;
const inserted = new Set<string>();

// Inserts a generated class's rule once. `setProperty` parses the value alone,
// so a value can't add rules or declarations, even if it comes from a user.
function insert(selector: string, className: string, property: string, value: string) {
  if (inserted.has(className)) return;
  inserted.add(className);
  // An unknown selector is ignored, as it is in the CSS file. Browsers without
  // constructable stylesheets, or where the list can't be changed (Chrome before
  // 99, Firefox before 101, Safari before 16.4), keep the defaults rather than
  // failing the render.
  try {
    if (sheet === undefined) {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets.push(sheet);
    }
    const index = sheet.insertRule(`${selector}{}`, sheet.cssRules.length);
    (sheet.cssRules[index] as CSSStyleRule).style.setProperty(property, value);
  } catch {}
}

export const create =
  (alphabet: string, invalid: InvalidValue) =>
  (classes: string, values: readonly unknown[], ...variables: RuntimeVariable[]): string => {
    let result = classes;
    for (const [name, strings, indexes, property, selector] of variables) {
      const value = text(strings, indexes, values, invalid);
      if (value === null) continue;
      const className = `_${name}${hash(value, alphabet)}`;
      // The server returns the same class strings, without the rules, so
      // hydration matches and the page uses its defaults until this runs.
      if (typeof document !== 'undefined')
        insert(
          selector ? selector.join(`.${className}`) : `.${className}`,
          className,
          property || `--${name}`,
          value,
        );
      result += result === '' ? className : ` ${className}`;
    }
    return result;
  };

// Production errors are numbered, to keep the runtime small. The site's
// `/errors` pages explain them, and `./runtime-dev.ts` has the full messages.
const invalidValue: InvalidValue = (value) => {
  throw new TypeError(`pre.style error 1 (${typeof value}): https://pre.style/errors/1`);
};

// What a block with `${…}` compiles to. It takes the block's class string, its
// expressions' values, so each runs once and in order, and its variables, and
// returns the class string with a generated class for each value.
export const dynamic = /* @__PURE__ */ create(CASE_SENSITIVE, invalidValue);

// For the `quirksMode` setting, where class selectors ignore case.
export const dynamicLowercase = /* @__PURE__ */ create(CASE_INSENSITIVE, invalidValue);

// The variables runtime values set, by short name: the custom property, or
// `''` for `--<name>`.
export type CnVariables = Record<string, string>;

// A `cn` lookup that also recognizes generated classes, which aren't in its
// table: `_`, a variable's name, and four characters. Each sets its variable on
// the element. It's here rather than in `cn`, so apps without `${…}` don't ship
// it.
export const generatedClasses = (variables: CnVariables): CnLookup =>
  new (class extends Map<string, readonly [string, string]> {
    override get(className: string) {
      const name = className.slice(1, -4);
      return (
        super.get(className) ??
        (className[0] === '_' && Object.hasOwn(variables, name)
          ? ['', variables[name] || `--${name}`]
          : undefined)
      );
    }
  })();
