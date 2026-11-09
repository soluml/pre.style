import { createHash } from 'node:crypto';
import type { Rule } from 'lightningcss';
import { atomDeclaration, key, overrideKey, valueOf } from './block.ts';
import type { Atom, GlobalRule } from './block.ts';

// With `keyframeLocalization`, each `@keyframes` name is replaced with a
// generated one, like styled-components' `keyframes`. In parsed rules, a
// local name is an ident with this prefix and a hash of every definition of
// the name in its scope (a block, or a stylesheet file), so identical
// keyframes share a name wherever they're defined. The compiler gives it a
// name when printing.
export const KEYFRAMES_PREFIX = '\0pre.style-keyframes:';

// Properties whose values name keyframes, without a vendor prefix.
const ANIMATION_PROPERTIES = new Set(['animation', 'animation-name']);

// Replaces each `@keyframes` name defined in a scope (in its globals, which
// include its prepended code) with a local name, in the definitions, and,
// through `atoms`, in `animation` and `animation-name` declarations. Names
// the scope doesn't define are left as they are.
export function localizeKeyframes(globals: GlobalRule[]): {
  globals: GlobalRule[];
  atoms: (atoms: Atom[]) => Atom[];
} {
  const definitions = new Map<string, string[]>();
  for (const global of globals)
    eachKeyframes(global.rule, (value) => {
      const list = definitions.get(value.name.value) ?? [];
      list.push(key({ vendorPrefix: value.vendorPrefix, keyframes: value.keyframes }));
      definitions.set(value.name.value, list);
    });
  if (definitions.size === 0) return { globals, atoms: (atoms) => atoms };

  const local = new Map<string, string>();
  for (const [name, list] of definitions)
    local.set(
      name,
      KEYFRAMES_PREFIX +
        createHash('sha256').update(JSON.stringify(list)).digest('base64url').slice(0, 16),
    );

  return {
    globals: globals.map((global) => {
      let found = false;
      const rule = mapRule(global.rule, (inner) => {
        if (inner.type !== 'keyframes') return inner;
        found = true;
        const value = valueOf(inner);
        return {
          ...inner,
          value: {
            ...value,
            name: { type: 'ident', value: local.get(value.name.value)! },
          },
        } as Rule;
      });
      if (!found) return global;
      return {
        ...global,
        key: key(rule),
        rule,
        overrideKey: global.overrideKey === null ? null : overrideKey(rule),
      };
    }),
    atoms: (atoms) =>
      atoms.map((atom) => {
        if (!ANIMATION_PROPERTIES.has(atom.property.replace(/^-\w+-/, ''))) return atom;
        const values = renameIdents(atom.declaration.values, local);
        if (values === atom.declaration.values) return atom;
        return { ...atom, declaration: atomDeclaration(values, atom.declaration.important) };
      }),
  };
}

type KeyframesValue = {
  name: { type: string; value: string };
  vendorPrefix: unknown;
  keyframes: unknown;
};

// Calls `visit` for each `@keyframes` rule in a rule, including inside the
// at-rules a global keeps around it.
function eachKeyframes(rule: Rule, visit: (value: KeyframesValue) => void) {
  mapRule(rule, (inner) => {
    if (inner.type === 'keyframes') visit(valueOf(inner) as KeyframesValue);
    return inner;
  });
}

// Maps a rule and the rules nested in it.
function mapRule(rule: Rule, map: (rule: Rule) => Rule): Rule {
  const value = valueOf(rule);
  const mapped = Array.isArray(value.rules)
    ? ({
        ...rule,
        value: {
          ...value,
          rules: value.rules.map((r: Rule) => mapRule(r, map)),
        },
      } as Rule)
    : rule;
  return map(mapped);
}

// Replaces names in idents and strings (parsed animation names, and tokens
// in unparsed values). Returns `value` itself when nothing changed.
function renameIdents<T>(value: T, local: Map<string, string>): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const mapped = node.map(visit);
      return mapped.some((item, i) => item !== node[i]) ? mapped : node;
    }
    if (node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    if (
      (record.type === 'ident' || record.type === 'string') &&
      typeof record.value === 'string' &&
      local.has(record.value)
    )
      return { type: 'ident', value: local.get(record.value) };
    let changed = false;
    const entries = Object.entries(record).map(([k, v]) => {
      const mapped = visit(v);
      if (mapped !== v) changed = true;
      return [k, mapped];
    });
    return changed ? Object.fromEntries(entries) : node;
  };
  return visit(value) as T;
}
