import { createHash } from 'node:crypto';
import type { Declaration, Rule } from 'lightningcss';
import { key, PreStyleError } from './block.ts';
import type { Atom, GlobalRule } from './block.ts';
import { atRuleInfo } from './at-rules.ts';
import { SLOT_PREFIX } from './interpolate.ts';

// A variable a block's runtime values set. In parsed rules, a generated
// variable's name is this prefix and a hash of what it's for, and the compiler
// gives it a name when printing, like localized keyframes.
export const VARIABLE_PREFIX = '--\0pre.style-variable:';

export interface Variable {
  // Its entry in the compiler's name list.
  key: string;
  // The custom property a user's own `--brand: ${color}` sets. Null when the
  // variable is generated, and named `--<its name>`.
  property: string | null;
  // The block's slot that holds its value.
  slot: number;
}

type VarNode = { type: 'var'; value: { name: { ident: string }; fallback?: unknown } };

const isSlot = (node: unknown): node is VarNode => {
  const value = node as VarNode | null;
  return value?.type === 'var' && value.value.name.ident.startsWith(SLOT_PREFIX);
};

const slotOf = (node: VarNode) => Number(node.value.name.ident.slice(SLOT_PREFIX.length));

// Calls `visit` for each slot in a value, in the order they're written.
function eachSlot(value: unknown, visit: (node: VarNode) => void) {
  if (Array.isArray(value)) {
    for (const item of value) eachSlot(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (isSlot(value)) visit(value);
  for (const child of Object.values(value)) eachSlot(child, visit);
}

const IGNORED = (token: { type: string; value?: { type?: string } }) =>
  token.type === 'token' && token.value?.type === 'white-space';

// The slot a declaration is entirely made of, for `--brand: ${color}` directly
// on the element, which can set `--brand` itself. Under at-rules or a selector
// variant, the generated class would have to be too, so those use a variable.
function directSlot(atom: Atom): VarNode | null {
  if (atom.atRules.length > 0 || atom.variant !== null || atom.declaration.important) return null;
  const declaration = atom.declaration.value as Declaration;
  if (declaration.property !== 'custom') return null;
  const tokens = (declaration.value.value as { type: string }[]).filter((t) => !IGNORED(t));
  const [token] = tokens;
  return tokens.length === 1 && isSlot(token) && !token.value.fallback ? token : null;
}

const hash = (identity: unknown) =>
  createHash('sha256').update(JSON.stringify(identity)).digest('base64url').slice(0, 16);

const generatedKey = (atom: Atom, index: number) =>
  hash([atom.atRules.map((segment) => segment.key), atom.variant?.key ?? '', atom.property, index]);

// `@property --a { syntax: "*"; inherits: false; }`. Without it, an element
// with no value of its own takes its parent's instead of its default.
const registration = (name: string): GlobalRule => {
  const rule = {
    type: 'property',
    value: {
      name,
      syntax: { type: 'universal' },
      inherits: false,
      initialValue: null,
      loc: { source_index: 0, line: 0, column: 1 },
    },
  } as unknown as Rule;
  return {
    key: key(rule),
    rule,
    hoist: atRuleInfo('property').hoist,
    overrideKey: null,
    position: null,
  };
};

const SLOT_MESSAGE =
  "`${…}` can only be used in a declaration's value, because it becomes a `var()`, which isn't valid here.";

// Replaces the slots in a global rule, such as a `@keyframes`, with variables
// identified by the rule and their place in it, so the same rule in any block
// shares them.
function globalVariables(
  global: GlobalRule,
  variables: Variable[],
  added: Map<string, GlobalRule>,
): GlobalRule {
  const rule = structuredClone(global.rule);
  const slots: VarNode[] = [];
  eachSlot(rule, (node) => slots.push(node));
  const numbers = slots.map(slotOf);
  slots.forEach((node, index) => {
    node.value.name.ident = `${SLOT_PREFIX}${index}`;
  });
  const identity = key(rule);
  slots.forEach((node, index) => {
    const variable = hash([identity, index]);
    variables.push({ key: variable, property: null, slot: numbers[index] });
    node.value.name.ident = VARIABLE_PREFIX + variable;
    if (!added.has(variable)) added.set(variable, registration(VARIABLE_PREFIX + variable));
  });
  const json = key(rule);
  // Anywhere else, such as a selector Sass built, it isn't a `var()` node.
  if (json.includes(SLOT_PREFIX)) throw new PreStyleError(SLOT_MESSAGE, global.position);
  return { ...global, key: json, rule };
}

// Turns a parsed block's placeholder variables into its real ones. Runs after
// overridden atoms are dropped, so their slots are left out. Variables are
// identified by what they're for, so `width: ${w}px` in any block shares one
// variable and class.
export function extractVariables(
  atoms: Atom[],
  globals: GlobalRule[],
): { atoms: Atom[]; globals: GlobalRule[]; variables: Variable[] } {
  const variables: Variable[] = [];
  const added = new Map<string, GlobalRule>();
  const kept = globals.map((global) =>
    global.key.includes(SLOT_PREFIX) ? globalVariables(global, variables, added) : global,
  );
  const keptAtoms: Atom[] = [];
  for (const atom of atoms) {
    const prefix = atom.atRules.map((segment) => segment.key).join() + (atom.variant?.key ?? '');
    // Sass can move a placeholder, so its position is checked again here.
    if (prefix.includes(SLOT_PREFIX)) throw new PreStyleError(SLOT_MESSAGE, atom.position);
    if (!atom.declaration.key.includes(SLOT_PREFIX)) {
      keptAtoms.push(atom);
      continue;
    }
    const direct = directSlot(atom);
    if (direct !== null) {
      variables.push({
        key: `direct:${atom.property}`,
        property: atom.property,
        slot: slotOf(direct),
      });
      continue;
    }
    const value = structuredClone(atom.declaration.value);
    let index = 0;
    eachSlot(value, (node) => {
      const variable = generatedKey(atom, index++);
      variables.push({ key: variable, property: null, slot: slotOf(node) });
      node.value.name.ident = VARIABLE_PREFIX + variable;
      if (!added.has(variable)) added.set(variable, registration(VARIABLE_PREFIX + variable));
    });
    keptAtoms.push({
      ...atom,
      declaration: {
        ...atom.declaration,
        key: key(value) + (atom.declaration.important ? '!' : ''),
        value,
      },
    });
  }
  return { atoms: keptAtoms, globals: [...kept, ...added.values()], variables };
}
