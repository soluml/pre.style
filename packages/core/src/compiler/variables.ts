import { createHash } from 'node:crypto';
import { transform } from 'lightningcss';
import type { Declaration, Rule } from 'lightningcss';
import { key, overrideKey, PreStyleError, valueOf } from './block.ts';
import type { Atom, GlobalRule, Position } from './block.ts';
import { atRuleInfo } from './at-rules.ts';
import { SLOT_PREFIX } from './interpolate.ts';
import { print } from './print.ts';

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

// A placeholder's slot, and its type from `type()`, which is in its name (in
// hex) so that blocks differing only by type don't share a parse.
const parseSlot = (node: VarNode) => {
  const [, slot, type] = /^(\d+)(?:-t([\da-f]+))?/.exec(
    node.value.name.ident.slice(SLOT_PREFIX.length),
  )!;
  return {
    slot: Number(slot),
    syntax: type === undefined ? null : Buffer.from(type, 'hex').toString(),
  };
};

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
  // Lightning CSS also uses `custom` for properties it doesn't parse, such as
  // `content` with a `var()`.
  if (declaration.property !== 'custom' || !atom.property.startsWith('--')) return null;
  const tokens = (declaration.value.value as { type: string }[]).filter((t) => !IGNORED(t));
  const [token] = tokens;
  if (tokens.length !== 1 || !isSlot(token)) return null;
  return !token.value.fallback || parseSlot(token).syntax !== null ? token : null;
}

const hash = (identity: unknown) =>
  createHash('sha256').update(JSON.stringify(identity)).digest('base64url').slice(0, 16);

const atomIdentity = (atom: Atom, index: number) => [
  atom.atRules.map((segment) => segment.key),
  atom.variant?.key ?? '',
  atom.property,
  index,
];

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

// Units and functions that depend on where they're used. Browsers drop a
// typed `@property` whose `initial-value` has them (tested in Chromium), and
// Lightning CSS doesn't report them.
const NOT_INDEPENDENT =
  /(?<![\w-])[+-]?[\d.]+(?:e[+-]?\d+)?(?:em|rem|ex|rex|ch|rch|lh|rlh|cap|rcap|ic|ric|cqw|cqh|cqi|cqb|cqmin|cqmax)\b|\b(?:env|attr)\(/i;
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

// A slot's default, as CSS.
function defaultText(node: VarNode): string {
  const rule = {
    type: 'style',
    value: {
      selectors: [[{ type: 'class', name: 'z' }]],
      declarations: {
        declarations: [
          { property: 'custom', value: { name: '--z', value: node.value.fallback ?? [] } },
        ],
      },
      rules: [],
      loc: { source_index: 0, line: 0, column: 1 },
    },
  } as unknown as Rule;
  const { code } = print([rule], [], {}, false);
  return /--z:\s*(.*?);?\s*\}/s.exec(code)![1];
}

// `@property --a { syntax: "<length>"; inherits: false; initial-value: 1px; }`.
function typedRegistration(
  name: string,
  syntax: string,
  initial: string,
  position: Position | null,
): GlobalRule {
  const invalid = (reason: string, cause?: unknown) =>
    new PreStyleError(
      `\`${initial}\` can't be the default of \`type(${syntax})\`: ${reason}`,
      position,
      { cause },
    );
  if (NOT_INDEPENDENT.test(initial.replace(QUOTED, '')))
    throw invalid(
      "a typed variable's default can't depend on where it's used, such as `em`, `rem`, container units, `env()`, or `attr()`, or browsers drop its `@property` rule. Use an absolute value, or leave out `type()`.",
    );
  let parsed: Rule | undefined;
  try {
    transform({
      filename: 'type.css',
      code: Buffer.from(
        `@property --z{syntax:${JSON.stringify(syntax)};inherits:false;initial-value:${initial}}`,
      ),
      visitor: {
        StyleSheetExit(sheet) {
          [parsed] = sheet.rules;
        },
      },
    });
  } catch (error) {
    throw invalid(`it isn't valid for that type (${(error as Error).message}).`, error);
  }
  const rule = { ...parsed!, value: { ...valueOf(parsed!), name } } as Rule;
  return {
    key: key(rule),
    rule,
    hoist: atRuleInfo('property').hoist,
    overrideKey: null,
    position,
  };
}

const SLOT_MESSAGE =
  "`${…}` can only be used in a declaration's value, because it becomes a `var()`, which isn't valid here.";

// Points a slot at its variable, and registers the variable. A typed
// variable's default moves to its `initial-value`, so each type and default
// has its own variable.
function useVariable(
  node: VarNode,
  identity: unknown,
  slot: number,
  syntax: string | null,
  variables: Variable[],
  added: Map<string, GlobalRule>,
  position: Position | null,
) {
  const initial = syntax === null ? null : defaultText(node);
  const variable = hash([identity, syntax, initial]);
  const name = VARIABLE_PREFIX + variable;
  variables.push({ key: variable, property: null, slot });
  node.value.name.ident = name;
  if (syntax !== null) node.value.fallback = null;
  if (added.has(variable)) return;
  added.set(
    variable,
    syntax === null ? registration(name) : typedRegistration(name, syntax, initial!, position),
  );
}

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
  const parsed = slots.map(parseSlot);
  slots.forEach((node, index) => {
    const type = parsed[index].syntax === null ? '' : `:${parsed[index].syntax}`;
    node.value.name.ident = `${SLOT_PREFIX}${index}${type}`;
  });
  const identity = key(rule);
  slots.forEach((node, index) => {
    const { slot, syntax } = parsed[index];
    useVariable(node, [identity, index], slot, syntax, variables, added, global.position);
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
      const { slot, syntax } = parseSlot(direct);
      variables.push({ key: `direct:${atom.property}`, property: atom.property, slot });
      // A typed custom property registers itself, under its own name.
      if (syntax !== null) {
        const registered = typedRegistration(
          atom.property,
          syntax,
          defaultText(direct),
          atom.position,
        );
        added.set(`direct:${atom.property}:${registered.key}`, {
          ...registered,
          overrideKey: overrideKey(registered.rule),
        });
      }
      continue;
    }
    const value = structuredClone(atom.declaration.value);
    let index = 0;
    eachSlot(value, (node) => {
      const { slot, syntax } = parseSlot(node);
      const identity = atomIdentity(atom, index++);
      useVariable(node, identity, slot, syntax, variables, added, atom.position);
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
