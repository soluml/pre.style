import { createHash } from 'node:crypto';
import type { Rule } from 'lightningcss';
import { key, overrideKey, parseRules, valueOf, walk } from './block.ts';
import type { Atom, GlobalRule, Lang, ParsedBlock, ParseOptions } from './block.ts';
import { VARIABLE_PREFIX } from './variables.ts';

// With `customPropertyLocalization`, a custom property that a block or
// stylesheet file declares gets a generated name, used only in that block or
// file. In parsed rules it's a variable name, which the compiler names when
// printing, in the same list as the variables runtime values set. Names it only
// reads, and names from prepended files, which are how values are shared, stay
// global.

// Properties whose values name custom properties. Other dashed names, such as
// `anchor-name: --x` or `anchor(--x top)`, aren't custom properties.
const NAMING = new Set(['will-change', 'transition', 'transition-property']);

type Node = Record<string, any>;

// Calls `declared` with each custom property a value declares.
function eachDeclared(value: unknown, declared: (name: string) => void) {
  if (Array.isArray(value)) {
    for (const item of value) eachDeclared(item, declared);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Node;
  if (node.property === 'custom' && node.value?.name?.startsWith('--')) declared(node.value.name);
  if (node.type === 'property' && typeof node.value?.name === 'string') declared(node.value.name);
  for (const child of Object.values(node)) eachDeclared(child, declared);
}

// Replaces custom property names in a value. Returns `value` itself when nothing
// changed.
function rename<T>(value: T, local: Map<string, string>, naming = false): T {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => rename(item, local, naming));
    return (mapped.some((item, i) => item !== value[i]) ? mapped : value) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const node = value as Node;
  // `var(--x)`.
  const ident = node.ident;
  // `transition-property`'s `{ property: '--x' }`.
  const property = node.property;
  // `will-change: --x`.
  const dashed = naming && node.type === 'dashed-ident' ? node.value : undefined;
  const isNaming =
    naming ||
    (node.property === 'custom' && NAMING.has(node.value?.name)) ||
    (node.property === 'unparsed' && NAMING.has(node.value?.propertyId?.property));
  let result: Node = node;
  const set = (field: string, next: unknown) => {
    if (result === node) result = { ...node };
    result[field] = next;
  };
  for (const [field, child] of Object.entries(node)) {
    const next = rename(child, local, isNaming);
    if (next !== child) set(field, next);
  }
  if (typeof ident === 'string' && local.has(ident)) set('ident', local.get(ident));
  if (typeof property === 'string' && local.has(property)) set('property', local.get(property));
  if (typeof dashed === 'string' && local.has(dashed)) set('value', local.get(dashed));
  // `--x: 1` and `@property --x`.
  if ((node.property === 'custom' || node.type === 'property') && local.has(result.value?.name))
    set('value', { ...result.value, name: local.get(result.value.name) });
  return result as T;
}

interface Prepended {
  keys: Set<string>;
  names: Set<string>;
}

const prepended = new Map<string, Prepended>();

// The rules and custom properties prepended files output. They're parsed once
// more on their own, and only with this setting on, since within a block they
// can't be told apart from its own rules.
function prependedOf(lang: Lang, options: ParseOptions): Prepended {
  const code = options.prepend[lang];
  const cacheKey = `${lang}\n${code}`;
  let result = prepended.get(cacheKey);
  if (result !== undefined) return result;
  result = { keys: new Set(), names: new Set() };
  if (code.trim() !== '') {
    const css =
      lang === 'scss' && options.sass !== null ? options.sass.compileString(code).css : code;
    const parsed: ParsedBlock = { atoms: [], globals: [], composes: [] };
    parseRules(
      css,
      options.lightningcss,
      () => null,
      (rules) => walk(rules, [], null, parsed, () => null),
    );
    for (const global of parsed.globals) {
      result.keys.add(global.key);
      eachDeclared(global.rule, (name) => result!.names.add(name));
    }
  }
  prepended.set(cacheKey, result);
  return result;
}

// Localizes the custom properties a scope (a block, or a whole stylesheet file)
// declares. `scope` identifies it, and has to be stable between builds.
export function localizeCustomProperties(
  atoms: Atom[],
  globals: GlobalRule[],
  scope: string,
  lang: Lang,
  options: ParseOptions,
): { globals: GlobalRule[]; atoms: (atoms: Atom[]) => Atom[] } {
  const shared = prependedOf(lang, options);
  const local = new Map<string, string>();
  const declared = (name: string) => {
    if (shared.names.has(name) || local.has(name)) return;
    const hash = createHash('sha256').update(`${scope}\n${name}`).digest('base64url').slice(0, 16);
    local.set(name, VARIABLE_PREFIX + hash);
  };
  for (const atom of atoms) eachDeclared(atom.declaration.value, declared);
  const own = (global: GlobalRule) => !shared.keys.has(global.key);
  for (const global of globals) if (own(global)) eachDeclared(global.rule, declared);
  if (local.size === 0) return { globals, atoms: (list) => list };

  return {
    globals: globals.map((global) => {
      if (!own(global)) return global;
      const rule = rename(global.rule, local) as Rule;
      if (rule === global.rule) return global;
      return {
        ...global,
        key: key(rule),
        rule,
        overrideKey: global.overrideKey === null ? null : overrideKey(rule),
      };
    }),
    atoms: (list) =>
      list.map((atom) => {
        const value = rename(atom.declaration.value, local);
        const atRules = atom.atRules.map((segment) => {
          const rule = rename(segment.rule, local);
          return rule === segment.rule ? segment : { key: key(valueKey(rule)), rule };
        });
        const unchanged =
          value === atom.declaration.value && atRules.every((s, i) => s === atom.atRules[i]);
        if (unchanged) return atom;
        return {
          ...atom,
          atRules,
          property: local.get(atom.property) ?? atom.property,
          declaration: {
            ...atom.declaration,
            key: key(value) + (atom.declaration.important ? '!' : ''),
            value,
          },
        };
      }),
  };
}

// The same key `walk` gives an at-rule.
const valueKey = (rule: Rule) => ({ type: rule.type, value: valueOf(rule) });
