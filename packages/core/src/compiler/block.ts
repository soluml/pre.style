import { composeVisitors, transform } from 'lightningcss';
import type {
  Declaration,
  Rule,
  SelectorList,
  TransformOptions,
  CustomAtRules,
} from 'lightningcss';
import { atRuleInfo } from './at-rules.ts';
import { expand } from './expand.ts';
import { localizeCustomProperties } from './custom-properties.ts';
import { SLOT_PREFIX } from './interpolate.ts';
import { localizeKeyframes } from './keyframes.ts';
import { compose, fromPlaceholder, isElement, PLACEHOLDER, repair } from './selectors.ts';
import { print } from './print.ts';
import { splitBlock } from './split.ts';
import { extractVariables } from './variables.ts';
import type { Variable } from './variables.ts';
import { SHORTHANDS } from '../shorthands.ts';

export type Lang = 'css' | 'scss';

// Lightning CSS options users can pass through. pre.style sets `filename`,
// `code`, `sourceMap`, and `projectRoot` itself, and doesn't support
// `inputSourceMap` or `cssModules`.
export type LightningOptions = Omit<
  TransformOptions<CustomAtRules>,
  'filename' | 'code' | 'sourceMap' | 'inputSourceMap' | 'projectRoot' | 'cssModules'
>;

// A position in a block: line from 0, column from 1, as Lightning CSS reports.
export interface Position {
  line: number;
  column: number;
}

export interface AtRuleSegment {
  key: string;
  // The at-rule without its child rules.
  rule: Rule;
}

export interface Atom {
  atRules: AtRuleSegment[];
  variant: { key: string; selectors: SelectorList } | null;
  // Usually one declaration. Declarations that set the same property in one
  // declaration list are kept together, in order, as fallbacks (`height:
  // 100%; height: 100svh`): a browser that can't parse the last one uses an
  // earlier one, which only works in the same rule.
  declaration: AtomDeclaration;
  // The property the declaration sets, and whether it's a shorthand that
  // couldn't be expanded.
  property: string;
  shorthand: boolean;
  position: Position | null;
}

export interface AtomDeclaration {
  key: string;
  values: Declaration[];
  important: boolean;
}

// An atom's declaration. A single declaration's key is its own key.
export const atomDeclaration = (values: Declaration[], important: boolean): AtomDeclaration => ({
  key: key(values.length === 1 ? values[0] : values) + (important ? '!' : ''),
  values,
  important,
});

export interface GlobalRule {
  key: string;
  rule: Rule;
  hoist: number | false;
  // Overridable at-rules with the same override key replace each other.
  overrideKey: string | null;
  position: Position | null;
}

// A `composes` declaration: classes from the same stylesheet, from another
// stylesheet file (a path as written, relative to the file it's in), or
// global class names, included as they are.
export interface Compose {
  names: string[];
  from: { type: 'local' } | { type: 'global' } | { type: 'file'; path: string };
  position: Position | null;
}

export interface ParsedBlock {
  atoms: Atom[];
  globals: GlobalRule[];
  composes: Compose[];
  // The variables its runtime values set, for a block with `${…}`.
  variables?: Variable[];
}

export class PreStyleError extends Error {
  readonly position: Position | null;
  constructor(message: string, position: Position | null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PreStyleError';
    this.position = position;
  }
}

export interface SassCompiler {
  compileString(
    source: string,
    options?: {
      // Relative loads resolve from this file.
      url?: URL;
      logger?: { warn?(message: string): void; debug?(message: string): void };
    },
  ): { css: string; loadedUrls?: URL[] };
}

export interface ParseOptions {
  lightningcss: LightningOptions;
  // Prepended code for each block type.
  prepend: Record<Lang, string>;
  sass: SassCompiler | null;
  // Receives Sass warnings and `@debug` messages.
  warn: (message: string) => void;
  // Give each `@keyframes` a generated name, used only in its own block or
  // stylesheet file.
  keyframeLocalization: boolean;
  // Give each custom property a block or stylesheet file declares a generated
  // name, used only there.
  customPropertyLocalization: boolean;
}

// JSON keys used to deduplicate. Locations are left out, so identical rules
// from different places share a key.
export const key = (value: unknown) =>
  JSON.stringify(value, (k, v) => (k === 'loc' ? undefined : v));

const HOIST_ORDER: Record<string, number> = { charset: 0, layer: 1, import: 2, namespace: 3 };

const hoistOrder = (rule: string) =>
  HOIST_ORDER[/^@([\w-]+)/.exec(rule)![1].toLowerCase()] ?? Infinity;

// Joins rules onto one line.
const oneLine = (rules: string[]) => rules.map((rule) => rule.replace(/\n/g, ' ')).join(' ');

const lineCount = (code: string) => code.split('\n').length - 1;

// Builds the stylesheet Lightning CSS parses for a block: the prepended
// code, then the block wrapped in a placeholder rule. Returns the code and
// the line the block starts on.
function wrap(
  code: string,
  lang: Lang,
  options: ParseOptions,
): { source: string; firstLine: number; firstColumn: number } {
  const prepend = options.prepend[lang];
  const open = `.${PLACEHOLDER}{`;
  if (lang === 'scss') {
    const head = `${prepend}\n`;
    return {
      source: `${head}${open}${code}\n}`,
      firstLine: lineCount(head),
      firstColumn: open.length,
    };
  }
  const { body, lifted } = splitBlock(code);
  // Lifted at-rules go on lines before the placeholder rule, so lines in the
  // body keep their positions. Statements (`@import`, `@layer a, b;`) go
  // first, since `@import` must come before other rules.
  // Statements are sorted by hoist order, since `@import` must come after
  // `@charset` and `@layer` statements and before `@namespace`.
  const statements = lifted
    .filter((rule) => rule.endsWith(';'))
    .toSorted((a, b) => hoistOrder(a) - hoistOrder(b));
  const blocks = lifted.filter((rule) => !rule.endsWith(';'));
  const head = `${oneLine(statements)}\n${prepend}\n${oneLine(blocks)}\n`;
  return {
    source: `${head}${open}${body}\n}`,
    firstLine: lineCount(head),
    firstColumn: open.length,
  };
}

export function parseBlock(code: string, lang: Lang, options: ParseOptions): ParsedBlock {
  if (lang === 'scss' && options.sass === null) {
    throw new PreStyleError(
      'Found an scss block, but Sass is not installed. Install the `sass` package to use scss blocks.',
      null,
    );
  }

  const { source, firstLine, firstColumn } = wrap(code, lang, options);
  // Positions in the wrapped source, converted back to the block. Positions
  // in prepended code or lifted at-rules map to the start of the block.
  const toBlock = (line: number, column: number): Position =>
    line < firstLine
      ? { line: 0, column: 1 }
      : {
          line: line - firstLine,
          column: line === firstLine ? Math.max(1, column - firstColumn) : column,
        };

  let css = source;
  if (lang === 'scss') {
    try {
      css = options.sass!.compileString(source, {
        logger: { warn: options.warn, debug: options.warn },
      }).css;
    } catch (error) {
      const span = (error as { span?: { start?: { line: number; column: number } } }).span?.start;
      throw new PreStyleError(
        `Sass failed to compile the block: ${(error as Error).message}`,
        span ? toBlock(span.line, span.column + 1) : null,
        {
          cause: error,
        },
      );
    }
  }

  const parsed: ParsedBlock = { atoms: [], globals: [], composes: [] };
  // Sass output positions don't match the block, so scss atoms have none.
  const position = (loc: { line: number; column: number } | undefined) =>
    lang === 'css' && loc ? toBlock(loc.line, loc.column) : null;

  parseRules(css, options.lightningcss, position, (rules) =>
    walk(rules, [], null, parsed, position),
  );

  let atoms = dropOverridden(pruneFallbacks(parsed.atoms, options.lightningcss));
  let { globals } = parsed;
  if (options.customPropertyLocalization) {
    const local = localizeCustomProperties(atoms, globals, `block\n${code}`, lang, options);
    atoms = local.atoms(atoms);
    ({ globals } = local);
  }
  let variables: Variable[] | undefined;
  if (code.includes(SLOT_PREFIX))
    ({ atoms, globals, variables } = extractVariables(atoms, globals));
  const composes = parsed.composes;
  if (!options.keyframeLocalization) return { atoms, globals, composes, variables };
  const local = localizeKeyframes(globals);
  return { atoms: local.atoms(atoms), globals: local.globals, composes, variables };
}

// Parses CSS with Lightning CSS, and passes its rules to `collect` once the
// user's visitor has changed them. `position` converts error locations.
export function parseRules(
  css: string,
  lightningcss: LightningOptions,
  position: ToPosition,
  collect: (rules: Rule[]) => void,
): void {
  const exit = {
    StyleSheetExit(sheet: { rules: Rule[] }) {
      collect(sheet.rules);
    },
  };
  const { visitor, ...rest } = lightningcss;
  try {
    transform({
      ...rest,
      filename: 'block.css',
      code: Buffer.from(css),
      visitor: visitor ? composeVisitors([visitor, exit as never]) : (exit as never),
    });
  } catch (error) {
    if (error instanceof PreStyleError) throw error;
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    // Lightning CSS reports error lines from 1.
    throw new PreStyleError(
      `Invalid CSS: ${(error as Error).message}`,
      loc ? position({ line: loc.line - 1, column: loc.column }) : null,
      { cause: error },
    );
  }
}

// Drops the fallbacks in each stack that Lightning CSS wouldn't print for the
// user's targets, so a stack that collapses to one declaration shares its
// class. Values Lightning CSS can't parse (such as `calc-size()`) are kept.
// Printing and parsing back changes some values' trees, so the round trip
// only decides which of the original declarations are kept.
export function pruneFallbacks(atoms: Atom[], lightningcss: LightningOptions): Atom[] {
  if (atoms.every((atom) => atom.declaration.values.length === 1)) return atoms;
  const { visitor: _visitor, minify: _minify, ...options } = lightningcss;
  // The stack as Lightning CSS prints it, parsed back, as keys. Declarations
  // it adds for other properties (vendor prefixes) are left out.
  const printed = (stack: Declaration[], important: boolean, property: string) => {
    const block = important ? { importantDeclarations: stack } : { declarations: stack };
    const rule = {
      type: 'style',
      value: {
        selectors: [[{ type: 'class', name: 'x' }]],
        declarations: block,
        rules: [],
        loc: { source_index: 0, line: 0, column: 1 },
      },
    } as unknown as Rule;
    let values: Declaration[] = [];
    parseRules(
      print([rule], [], options, false).code,
      options,
      () => null,
      (rules) => {
        const parsed = valueOf(rules[0]).declarations ?? {};
        values = (important ? parsed.importantDeclarations : parsed.declarations) ?? [];
      },
    );
    return values.filter((value) => propertyOf(value).property === property).map(key);
  };
  return atoms.map((atom) => {
    const { values: stack, important } = atom.declaration;
    if (stack.length === 1) return atom;
    let kept: Declaration[];
    try {
      const remaining = printed(stack, important, atom.property);
      if (remaining.length === stack.length) return atom;
      kept = stack.filter((value) => {
        const own = printed([value], important, atom.property).at(-1);
        if (own !== remaining[0]) return false;
        remaining.shift();
        return true;
      });
    } catch {
      return atom;
    }
    if (kept.length === 0) return atom;
    return { ...atom, declaration: atomDeclaration(kept, important) };
  });
}

// Within a block, a later declaration overrides an earlier one that sets the
// same property under the same at-rules and selector variant, as in CSS.
// `!important` declarations are collected after normal ones in each rule,
// so they win. Identical atoms are kept once.
export function dropOverridden(atoms: Atom[]): Atom[] {
  const seen = new Set<string>();
  const kept: Atom[] = [];
  for (let i = atoms.length - 1; i >= 0; i--) {
    const atom = atoms[i];
    const prefix = `${atom.atRules.map((s) => s.key).join('\n')}\n${atom.variant?.key ?? ''}\n`;
    if (seen.has(prefix + atom.property)) continue;
    seen.add(prefix + atom.property);
    if (atom.shorthand)
      for (const longhand of SHORTHANDS[atom.property]) seen.add(prefix + longhand);
    kept.push(atom);
  }
  return kept.toReversed();
}

export type ToPosition = (loc: { line: number; column: number } | undefined) => Position | null;

// Every rule but `ignored` has a value.
export const valueOf = (rule: Rule): Record<string, any> =>
  'value' in rule && rule.value !== null ? rule.value : {};

const ruleLoc = (rule: Rule): { line: number; column: number } | undefined => valueOf(rule).loc;

// Walks the rules. `variant` is the element's selector variant when inside a
// rule that targets the element, and null outside one. Without the
// placeholder, every rule is global.
export function walk(
  rules: Rule[],
  atRules: AtRuleSegment[],
  variant: SelectorList | null,
  parsed: ParsedBlock,
  position: ToPosition,
) {
  for (const rule of rules) {
    if (rule.type === 'style') {
      const { selectors, declarations, rules: children = [], loc } = rule.value;
      if (variant !== null) {
        const composed = compose(variant, selectors);
        addDeclarations(declarations, atRules, composed, parsed.atoms, null, position(loc));
        walk(children, atRules, composed, parsed, position);
        continue;
      }
      // Outside the element, only selectors with the placeholder target it.
      const element: SelectorList = [];
      const other: SelectorList = [];
      for (const selector of selectors) {
        const resolved = fromPlaceholder(selector);
        if (resolved) element.push(resolved);
        else other.push(selector);
      }
      if (other.length > 0)
        addGlobal(
          { ...rule, value: { ...rule.value, selectors: other } },
          atRules,
          parsed.globals,
          position,
        );
      if (element.length > 0) {
        // `composes` only works directly in the block, outside at-rules.
        const composes = atRules.length === 0 && isElement(element) ? parsed.composes : null;
        addDeclarations(declarations, atRules, element, parsed.atoms, composes, position(loc));
        walk(children, atRules, element, parsed, position);
      }
      continue;
    }

    if (rule.type === 'nested-declarations' && variant !== null) {
      addDeclarations(
        rule.value.declarations,
        atRules,
        variant,
        parsed.atoms,
        null,
        position(rule.value.loc),
      );
      continue;
    }

    if (atRuleInfo(rule.type).atomic) {
      const { rules: children, ...value } = valueOf(rule) as { rules: Rule[] };
      const segment = {
        key: key({ type: rule.type, value }),
        rule: { type: rule.type, value } as Rule,
      };
      walk(children, [...atRules, segment], variant, parsed, position);
      continue;
    }

    addGlobal(rule, atRules, parsed.globals, position);
  }
}

const COMPOSES_PLACEMENT =
  "`composes` must come before the rule's other declarations, and can't be used inside nested selectors or at-rules.";

const isComposes = (declaration: Declaration) =>
  declaration.property === 'unparsed' && declaration.value.propertyId.property === 'composes';

// Adds a rule's declarations as atoms. `composes` declarations are added to
// `composes` when it's given, and are an error where it isn't (inside
// nested selectors and at-rules).
export function addDeclarations(
  block: { declarations?: Declaration[]; importantDeclarations?: Declaration[] } | undefined,
  atRules: AtRuleSegment[],
  selectors: SelectorList,
  atoms: Atom[],
  composes: Compose[] | null,
  position: Position | null,
) {
  let variant: Atom['variant'] = null;
  if (!isElement(selectors)) {
    const repaired = repair(selectors);
    variant = { key: key(repaired), selectors: repaired };
  }
  if (block?.importantDeclarations?.some(isComposes))
    throw new PreStyleError("`composes` can't be `!important`.", position);
  let normal = block?.declarations ?? [];
  // As in CSS Modules, `composes` comes before the rule's other declarations.
  const leading = normal.findIndex((d) => !isComposes(d));
  const own = leading === -1 ? normal.length : leading;
  if (normal.slice(own).some(isComposes)) throw new PreStyleError(COMPOSES_PLACEMENT, position);
  if (own > 0) {
    if (composes === null) throw new PreStyleError(COMPOSES_PLACEMENT, position);
    for (const d of normal.slice(0, own)) composes.push(parseComposes(d, position));
    normal = normal.slice(own);
  }
  // Declarations of the same property in this list are stacked, in order, as
  // fallbacks, at the place of the last one. A declaration that always parses
  // replaces the stack, since nothing before it can ever apply.
  const add = (declarations: Declaration[] = [], important: boolean) => {
    const stacks = new Map<string, Declaration[]>();
    const list: { property: string; shorthand: boolean; values: Declaration[] }[] = [];
    for (const declaration of declarations) {
      for (const value of expand(declaration)) {
        const { property, shorthand } = propertyOf(value);
        const stack = stacks.get(property);
        if (stack)
          list.splice(
            list.findIndex((item) => item.values === stack),
            1,
          );
        const values = stack && !alwaysParses(value, property) ? [...stack, value] : [value];
        stacks.set(property, values);
        list.push({ property, shorthand, values });
      }
    }
    for (const { property, shorthand, values } of list)
      atoms.push({
        atRules,
        variant,
        declaration: atomDeclaration(values, important),
        property,
        shorthand,
        position,
      });
  };
  add(normal, false);
  add(block?.importantDeclarations, true);
}

// Whether a browser always parses a declaration, so it can't fall back to an
// earlier one: custom properties take any value, and `var()` and `env()`
// (including `${…}`, which becomes a `var()`) are only checked once they're
// substituted, when an invalid value makes the property `unset`.
function alwaysParses(value: Declaration, property: string): boolean {
  return property.startsWith('--') || /"type":"(?:var|env)"/.test(key(value));
}

const ident = (t: { type: string; value?: any } | undefined) =>
  t?.type === 'token' && t.value.type === 'ident' ? (t.value.value as string) : null;

// Reads `composes: a b`, `composes: a from './file.css'`, or
// `composes: a from global`.
function parseComposes(declaration: Declaration, position: Position | null): Compose {
  const tokens = (declaration.value as { value: { type: string; value?: any }[] }).value.filter(
    (t) => !(t.type === 'token' && t.value.type === 'white-space'),
  );
  const invalid = () =>
    new PreStyleError(
      'Invalid `composes`. Use `composes: a b;`, `composes: a from "./file.css";`, or `composes: a from global;`.',
      position,
    );
  const names: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const name = ident(tokens[i]);
    if (name === null || name === 'from') break;
    names.push(name);
  }
  if (names.length === 0) throw invalid();
  if (i === tokens.length) return { names, from: { type: 'local' }, position };
  if (ident(tokens[i]) !== 'from' || tokens.length !== i + 2) throw invalid();
  const source = tokens[i + 1];
  if (ident(source) === 'global') return { names, from: { type: 'global' }, position };
  if (source.type === 'token' && source.value.type === 'string')
    return { names, from: { type: 'file', path: source.value.value }, position };
  throw invalid();
}

// Global rules inside at-rules keep their at-rules around them.
export function addGlobal(
  rule: Rule,
  atRules: AtRuleSegment[],
  globals: GlobalRule[],
  position: ToPosition,
) {
  let wrapped = rule;
  for (const segment of atRules.toReversed()) {
    wrapped = {
      type: segment.rule.type,
      value: { ...valueOf(segment.rule), rules: [wrapped] },
    } as Rule;
  }
  const info = atRules.length === 0 ? atRuleInfo(rule.type) : atRuleInfo('');
  wrapped = repair(wrapped);
  globals.push({
    key: key(wrapped),
    rule: wrapped,
    hoist: info.hoist,
    overrideKey: info.overridable ? overrideKey(rule) : null,
    position: position(ruleLoc(rule)),
  });
}

// The identity of an overridable at-rule: its type and name.
export function overrideKey(rule: Rule): string {
  const value = valueOf(rule);
  switch (rule.type) {
    case 'keyframes':
      // `@-webkit-keyframes x` doesn't replace `@keyframes x`.
      return `keyframes ${key(value.vendorPrefix ?? [])} ${key(value.name)}`;
    case 'font-face': {
      // A font face is identified by its family, style, weight, and stretch.
      const descriptors = Object.fromEntries(
        (value.properties as { type: string; value: unknown }[])
          .filter((p) =>
            ['font-family', 'font-style', 'font-weight', 'font-stretch', 'unicode-range'].includes(
              p.type,
            ),
          )
          .map((p) => [p.type, p.value]),
      );
      return `font-face ${key(descriptors)}`;
    }
    case 'view-transition':
      return 'view-transition';
    case 'namespace':
      return `namespace ${value.prefix ?? ''}`;
    default:
      return `${rule.type} ${key(value.name)}`;
  }
}

// The property a declaration sets, and whether it's a shorthand that wasn't
// expanded.
const prefix = (vendorPrefix: string[] | undefined) =>
  vendorPrefix && vendorPrefix.length > 0 ? `-${vendorPrefix[0]}-` : '';

export function propertyOf(declaration: Declaration): { property: string; shorthand: boolean } {
  let property: string;
  if (declaration.property === 'unparsed') {
    const id = declaration.value.propertyId as { property: string; vendorPrefix?: string[] };
    property = prefix(id.vendorPrefix) + id.property;
  } else if (declaration.property === 'custom') {
    property = declaration.value.name;
  } else {
    property =
      prefix((declaration as { vendorPrefix?: string[] }).vendorPrefix) + declaration.property;
  }
  return { property, shorthand: Object.hasOwn(SHORTHANDS, property) };
}
