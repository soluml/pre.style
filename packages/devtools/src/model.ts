export interface Source {
  file: string;
  // Relative to the app, with forward slashes.
  path: string;
  line: number;
  column: number;
}

// One atomic class, as `/__pre.style/usages` describes it.
export interface Rule {
  className: string;
  selector: string;
  atRules: string[];
  declaration: string;
  property: string;
  covers: string[];
  important: boolean;
  specificity: [number, number, number];
  order: number;
  sources: Source[];
  // Inserted by the runtime for a value in a `${…}`, not in the CSS file.
  generated?: boolean;
}

// A rule the runtime inserted, as the page reports it.
export interface GeneratedRule {
  className: string;
  selector: string;
  property: string;
  value: string;
  specificity: [number, number, number];
  index: number;
}

export interface Usages {
  version: number;
  editor: string;
  // The app's root, which the paths in class attributes are relative to.
  // Missing from older versions of the plugin.
  root?: string;
  // Whether the plugin marks class attributes (its `sourceAttributes` option).
  // Missing from older versions of the plugin.
  classAttributes?: boolean;
  rules: Rule[];
}

export interface ShownRule extends Rule {
  // A rule above it sets the same property.
  overridden: boolean;
}

export interface View {
  // Rules that apply to the element, most important first, like the Styles pane.
  applied: ShownRule[];
  // Rules for pseudo-elements, by pseudo-element.
  pseudo: { name: string; rules: ShownRule[] }[];
  // Rules from the element's classes that don't apply right now (`:hover`,
  // a media query, and so on).
  inactive: Rule[];
}

// Includes the older `:before` form, which Lightning CSS writes.
const PSEUDO_ELEMENT = /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)\b/;
const layered = (rule: Rule) => rule.atRules.some((atRule) => atRule.startsWith('@layer'));

// Negative when `a` wins. Unlayered styles beat layered ones, and the other way
// around for `!important`. Layers are otherwise compared by output order, which
// can differ from an explicit `@layer a, b` order.
export function compareCascade(a: Rule, b: Rule): number {
  if (a.important !== b.important) return a.important ? -1 : 1;
  if (layered(a) !== layered(b)) return layered(a) !== a.important ? 1 : -1;
  for (const index of [0, 1, 2]) {
    const difference = b.specificity[index] - a.specificity[index];
    if (difference !== 0) return difference;
  }
  return b.order - a.order;
}

// The runtime's stylesheet comes after the CSS file, so its rules are later than
// any the dev server numbers.
const GENERATED_ORDER = 1_000_000_000;

// Adds the runtime's rules to what the dev server reported. They aren't in any
// file, so each takes its sources from the rules that read its variable.
export function withGenerated(rules: Rule[], generated: GeneratedRule[]): Rule[] {
  const added = generated.map(
    ({ className, selector, property, value, specificity, index }): Rule => {
      const reads = new RegExp(`var\\(\\s*${RegExp.escape(property)}(?![\\w-])`);
      const places = new Map<string, Source>();
      for (const rule of rules)
        if (reads.test(rule.declaration) || rule.property === property)
          for (const source of rule.sources)
            places.set(`${source.file}:${source.line}:${source.column}`, source);
      return {
        className,
        selector,
        atRules: [],
        declaration: `${property}: ${value}`,
        property,
        covers: [],
        important: false,
        specificity,
        order: GENERATED_ORDER + index,
        sources: [...places.values()],
        generated: true,
      };
    },
  );
  return [...rules, ...added];
}

// Marks what's overridden among these rules. A shorthand overrides the longhands
// it covers. A longhand only overrides part of a shorthand, so that isn't marked.
function resolve(rules: Rule[]): ShownRule[] {
  const set = new Set<string>();
  return rules.toSorted(compareCascade).map((rule) => {
    const overridden = set.has(rule.property);
    set.add(rule.property);
    for (const longhand of rule.covers) set.add(longhand);
    return { ...rule, overridden };
  });
}

const matchesFilter = (rule: Rule, filter: string) =>
  [
    rule.className,
    rule.selector,
    rule.declaration,
    ...rule.atRules,
    ...rule.sources.map((source) => source.path),
  ].some((text) => text.toLowerCase().includes(filter));

// Puts the files most likely to have produced the element first: those using the
// most of its classes, then by path, so the order doesn't depend on what compiled
// first. It's a guess, since a file with many blocks can score well too.
function rankSources(rules: Rule[], owned: Set<string>): Rule[] {
  const scores = new Map<string, number>();
  for (const rule of rules) {
    if (!owned.has(rule.className)) continue;
    for (const file of new Set(rule.sources.map((source) => source.file)))
      scores.set(file, (scores.get(file) ?? 0) + 1);
  }
  const score = (source: Source) => scores.get(source.file) ?? 0;
  return rules.map((rule) => ({
    ...rule,
    sources: rule.sources.toSorted(
      (a, b) =>
        score(b) - score(a) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.line - b.line ||
        a.column - b.column,
    ),
  }));
}

export function buildView(rules: Rule[], matched: boolean[], own: string[], filter: string): View {
  const owned = new Set(own);
  const normal: Rule[] = [];
  const pseudo = new Map<string, Rule[]>();
  const inactive: Rule[] = [];
  rankSources(rules, owned).forEach((rule, index) => {
    if (!matched[index]) {
      // Rules from other elements' classes only matter if they reach this one.
      if (owned.has(rule.className)) inactive.push(rule);
      return;
    }
    const name = PSEUDO_ELEMENT.exec(rule.selector)?.[0].replace(/^:(?!:)/, '::');
    if (name === undefined) normal.push(rule);
    else pseudo.set(name, [...(pseudo.get(name) ?? []), rule]);
  });
  // Filtered after resolving, so a hidden rule still overrides what it overrides.
  const needle = filter.trim().toLowerCase();
  const keep = <T extends Rule>(list: T[]) =>
    needle === '' ? list : list.filter((rule) => matchesFilter(rule, needle));
  return {
    applied: keep(resolve(normal)),
    pseudo: [...pseudo]
      .map(([name, list]) => ({ name, rules: keep(resolve(list)) }))
      .filter(({ rules: list }) => list.length > 0)
      .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    inactive: keep(inactive.toSorted(compareCascade)),
  };
}

// The classes to ask the dev server about, in a stable order.
export const classesToFetch = (own: string[], context: string[]) =>
  [...new Set([...own, ...context])].filter((name) => /^[\w-]+$/.test(name)).toSorted();

// Whether any of the dev server's rules is for one of the element's own classes.
export const hasRules = (rules: Rule[], own: string[]) =>
  rules.some(({ className }) => own.includes(className));

export const fileCount = (sources: Source[]) => new Set(sources.map(({ file }) => file)).size;

export const location = ({ path, line, column }: Source) => `${path}:${line}:${column}`;

// A `path:line:column` from a class attribute, as a source. Null when it can't
// be read.
export function attributeSource(value: string | null, root: string | undefined): Source | null {
  const match = value === null ? null : /^(.+):(\d+):(\d+)$/.exec(value);
  if (match === null || root === undefined) return null;
  const [, path, line, column] = match;
  return {
    file: `${root.replace(/\/$/, '')}/${path}`,
    path,
    line: Number(line),
    column: Number(column),
  };
}

// The URL that opens a source in the editor, through Vite's route.
export const editorUrl = (editor: string, { file, line, column }: Source) =>
  `${editor}?file=${encodeURIComponent(`${file}:${line}:${column}`)}`;
