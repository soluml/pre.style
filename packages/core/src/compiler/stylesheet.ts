import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Declaration, Rule, Selector, SelectorComponent, SelectorList } from 'lightningcss';
import { atRuleInfo } from './at-rules.ts';
import {
  addDeclarations,
  addGlobal,
  dropOverridden,
  key,
  parseRules,
  PreStyleError,
  valueOf,
  walk,
} from './block.ts';
import type {
  Atom,
  AtRuleSegment,
  Compose,
  GlobalRule,
  Lang,
  ParsedBlock,
  ParseOptions,
  Position,
  ToPosition,
} from './block.ts';
import { localizeCustomProperties } from './custom-properties.ts';
import { localizeKeyframes } from './keyframes.ts';
import { compose, isElement } from './selectors.ts';

// Classes used as context for another class (`.card:hover .title`), or in a
// compound with it (`.a.b`), are replaced with a marker: one generated name
// added to that class's string. In parsed selectors, a marker is a class
// named with this prefix, the stylesheet's ID, and the class, so markers
// from different files never share a key. The compiler gives it a name when
// printing.
export const MARKER_PREFIX = '\0pre.style-marker:';

export const markerKey = (id: string, name: string) => `${MARKER_PREFIX}${id}\0${name}`;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
  'arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(
    ' ',
  ),
);

// Whether a class can be exported as a `const` of the same name. Others
// (such as `primary-button`) are exported by string name.
export const isIdentifier = (name: string) => IDENTIFIER.test(name) && !RESERVED.has(name);

export interface StylesheetClass {
  atoms: Atom[];
  composes: Compose[];
  // Whether the class is used as context or in a compound, so its string
  // includes its marker.
  marker: boolean;
}

export interface ParsedStylesheet {
  // Every exported class, in the order it first appears.
  classes: Map<string, StylesheetClass>;
  globals: GlobalRule[];
  // Other files the stylesheet loaded (Sass `@use`, `@forward`, and
  // `@import`), as absolute paths.
  dependencies: string[];
}

// Separates the CSS Sass writes for prepended code (and modules loaded with
// `@use`, which Sass writes first) from the file's own.
const SPLIT = '/*! __pre-style-split__ */';

// Leading `@use` and `@forward` rules, which Sass requires before any other
// rule, so they're moved above the prepended code.
const LEADING_MODULE_RULE = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|@(?:use|forward)\b[^;]*;)/;

// A style rule, or (with `global`) another rule that isn't an atomic
// at-rule.
const none: ToPosition = () => null;

interface Entry {
  global?: Rule;
  selectors: SelectorList;
  declarations: { declarations?: Declaration[]; importantDeclarations?: Declaration[] };
  atRules: AtRuleSegment[];
  // Whether the declarations are inside another style rule.
  nested: boolean;
  loc: unknown;
  position: Position | null;
}

// Parses a stylesheet file. Each class becomes a block: its rules, with the
// class replaced by `&`, wherever they appear in the file. Rules that don't
// target a class, and the prepended code's rules, are global. `id` names the
// file in marker keys.
export function parseStylesheet(
  code: string,
  lang: Lang,
  file: string,
  id: string,
  options: ParseOptions,
): ParsedStylesheet {
  if (lang === 'scss' && options.sass === null) {
    throw new PreStyleError(
      'Found an scss file, but Sass is not installed. Install the `sass` package to use scss files.',
      null,
    );
  }

  let head = options.prepend[lang];
  let body = code;
  let dependencies: string[] = [];
  if (lang === 'scss') {
    const modules: string[] = [];
    let rest = code;
    let offset = 0;
    for (let match; (match = LEADING_MODULE_RULE.exec(rest));) {
      if (match[0].startsWith('@')) modules.push(match[0]);
      offset += match[0].length;
      rest = rest.slice(match[0].length);
    }
    // Blanked, not removed, so Sass reports the file's own line numbers.
    const kept = code.slice(0, offset).replace(/[^\n]/g, ' ') + rest;
    const prefix = `${modules.join('\n')}\n${head}\n${SPLIT}\n`;
    const firstLine = prefix.split('\n').length - 1;
    let compiled: { css: string; loadedUrls?: URL[] };
    try {
      compiled = options.sass!.compileString(prefix + kept, {
        url: pathToFileURL(file),
        logger: { warn: options.warn, debug: options.warn },
      });
    } catch (error) {
      const span = (error as { span?: { start?: { line: number; column: number } } }).span?.start;
      throw new PreStyleError(
        `Sass failed to compile the file: ${(error as Error).message}`,
        span && span.line >= firstLine
          ? { line: span.line - firstLine, column: span.column + 1 }
          : null,
        { cause: error },
      );
    }
    const at = compiled.css.indexOf(SPLIT);
    head = at === -1 ? '' : compiled.css.slice(0, at);
    body = at === -1 ? compiled.css : compiled.css.slice(at + SPLIT.length);
    dependencies = (compiled.loadedUrls ?? [])
      .filter((url) => url.protocol === 'file:')
      .map((url) => fileURLToPath(url))
      .filter((path) => path !== file);
  }

  // Sass output positions don't match the file, so scss atoms have none.
  // Lightning CSS lines start from 0 and columns from 1, like positions.
  const position: ToPosition = (loc) =>
    lang === 'css' && loc ? { line: loc.line, column: loc.column } : null;

  // The prepended code's rules are all global.
  const prepended: ParsedBlock = { atoms: [], globals: [], composes: [] };
  if (head.trim() !== '')
    parseRules(head, options.lightningcss, none, (rules) => walk(rules, [], null, prepended, none));

  const entries: Entry[] = [];
  parseRules(body, options.lightningcss, position, (rules) =>
    flatten(rules, [], null, entries, position),
  );

  // Every class that owns a rule, or is in a compound with the class that
  // does, is exported. Other classes (such as `.dark`) are global names.
  const classes = new Map<string, StylesheetClass>();
  for (const entry of entries) {
    if (entry.global) continue;
    for (const selector of entry.selectors) {
      const owner = ownerOf(selector);
      if (owner === null) continue;
      for (const name of owner.compound)
        if (!classes.has(name)) classes.set(name, { atoms: [], composes: [], marker: false });
    }
  }

  // Replaces exported classes, other than the one at `skip`, with markers.
  const withMarkers = (selector: Selector, skip: number): Selector =>
    selector.map((component, i) => {
      if (i === skip) return { type: 'nesting' };
      return replaceClasses(component, (name) => {
        const target = classes.get(name);
        if (target === undefined) return null;
        target.marker = true;
        return markerKey(id, name);
      });
    });

  const parsed: ParsedStylesheet = { classes, globals: [...prepended.globals], dependencies };
  for (const entry of entries) {
    if (entry.global) {
      addGlobal(entry.global, entry.atRules, parsed.globals, position);
      continue;
    }
    const owned = new Map<string, SelectorList>();
    const other: SelectorList = [];
    for (const selector of entry.selectors) {
      const owner = ownerOf(selector);
      if (owner === null) other.push(withMarkers(selector, -1));
      else {
        const list = owned.get(owner.name) ?? [];
        list.push(withMarkers(selector, owner.index));
        owned.set(owner.name, list);
      }
    }
    for (const [name, selectors] of owned) {
      const target = classes.get(name)!;
      // `composes` only works in a rule for the class alone, outside
      // nested selectors and at-rules.
      const composes =
        !entry.nested && entry.atRules.length === 0 && isElement(selectors)
          ? target.composes
          : null;
      addDeclarations(
        entry.declarations,
        entry.atRules,
        selectors,
        target.atoms,
        composes,
        entry.position,
      );
    }
    const { declarations = [], importantDeclarations = [] } = entry.declarations;
    if (other.length > 0 && declarations.length + importantDeclarations.length > 0) {
      const rule = {
        type: 'style',
        value: { selectors: other, declarations: entry.declarations, rules: [], loc: entry.loc },
      } as unknown as Rule;
      addGlobal(rule, entry.atRules, parsed.globals, () => entry.position);
    }
  }

  for (const target of classes.values()) target.atoms = dropOverridden(target.atoms);
  // Custom properties are local to the whole file, like keyframes.
  if (options.customPropertyLocalization) {
    const all = [...classes.values()].flatMap((target) => target.atoms);
    const local = localizeCustomProperties(all, parsed.globals, `file\n${id}`, lang, options);
    parsed.globals = local.globals;
    for (const target of classes.values()) target.atoms = local.atoms(target.atoms);
  }
  // Keyframes are local to the whole file, as in CSS Modules.
  if (options.keyframeLocalization) {
    const local = localizeKeyframes(parsed.globals);
    parsed.globals = local.globals;
    for (const target of classes.values()) target.atoms = local.atoms(target.atoms);
  }
  return parsed;
}

// Flattens rules into entries, in order: style rules with their full
// selectors, resolving nesting, and other rules that aren't atomic at-rules,
// which are global.
function flatten(
  rules: Rule[],
  atRules: AtRuleSegment[],
  parent: SelectorList | null,
  entries: Entry[],
  position: ToPosition,
) {
  for (const rule of rules) {
    if (rule.type === 'style') {
      const { selectors, declarations, rules: children = [], loc } = rule.value;
      const full = parent === null ? selectors : compose(parent, selectors);
      entries.push({
        selectors: full,
        declarations: declarations ?? {},
        atRules,
        nested: parent !== null,
        loc,
        position: position(loc),
      });
      flatten(children, atRules, full, entries, position);
      continue;
    }
    if (rule.type === 'nested-declarations' && parent !== null) {
      entries.push({
        selectors: parent,
        declarations: rule.value.declarations ?? {},
        atRules,
        nested: true,
        loc: rule.value.loc,
        position: position(rule.value.loc),
      });
      continue;
    }
    if (atRuleInfo(rule.type).atomic) {
      const { rules: children, ...value } = valueOf(rule) as { rules: Rule[] };
      const segment = {
        key: key({ type: rule.type, value }),
        rule: { type: rule.type, value } as Rule,
      };
      flatten(children, [...atRules, segment], parent, entries, position);
      continue;
    }
    entries.push({
      global: rule,
      selectors: [],
      declarations: {},
      atRules,
      nested: parent !== null,
      loc: undefined,
      position: null,
    });
  }
}

// The class a selector's declarations belong to: the first class in the
// rightmost compound that has one, so `.card .title` belongs to `title` and
// `.card > div` to `card`. `compound` lists every class in that compound.
// Null when the selector has no class outside pseudo-class arguments.
function ownerOf(selector: Selector): { name: string; index: number; compound: string[] } | null {
  let end = selector.length;
  for (let start = selector.length - 1; start >= -1; start--) {
    if (start !== -1 && selector[start].type !== 'combinator') continue;
    const compound: { name: string; index: number }[] = [];
    for (let i = start + 1; i < end; i++) {
      const c = selector[i];
      if (c.type === 'class') compound.push({ name: c.name, index: i });
    }
    if (compound.length > 0) return { ...compound[0], compound: compound.map(({ name }) => name) };
    end = start;
  }
  return null;
}

// Replaces class names in a selector component, including inside
// pseudo-class arguments. `replace` returns the new name, or null to keep it.
function replaceClasses(
  component: SelectorComponent,
  replace: (name: string) => string | null,
): SelectorComponent {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (node.type === 'class' && typeof node.name === 'string') {
      const name = replace(node.name);
      return name === null ? node : { ...node, name };
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
  };
  return visit(component) as SelectorComponent;
}
