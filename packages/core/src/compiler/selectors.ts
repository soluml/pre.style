import type { Selector, SelectorComponent, SelectorList } from 'lightningcss';

// Blocks are wrapped in a rule with this class before parsing. In the
// parsed selectors it's replaced with a nesting selector (`&`), which marks
// where the element's class goes.
export const PLACEHOLDER = '__pre-style__';

const NESTING: SelectorComponent = { type: 'nesting' };

const isNesting = (c: SelectorComponent) => c.type === 'nesting';
const isPlaceholder = (c: SelectorComponent) => c.type === 'class' && c.name === PLACEHOLDER;

// Replaces the placeholder class with `&`, or returns null if the selector
// doesn't target the element.
export function fromPlaceholder(selector: Selector): Selector | null {
  if (!selector.some(isPlaceholder)) return null;
  return selector.map((c) => (isPlaceholder(c) ? NESTING : c));
}

// Whether the selector list is only the element itself (`&`).
export function isElement(selectors: SelectorList): boolean {
  return selectors.length === 1 && selectors[0].length === 1 && isNesting(selectors[0][0]);
}

// Resolves a nested selector list against its parent, so `&:hover` inside
// `.dark &` becomes `.dark &:hover`. Each parent and child selector pair
// produces one selector, as Sass does.
export function compose(parent: SelectorList, child: SelectorList): SelectorList {
  const result: SelectorList = [];
  for (const p of parent) {
    const simple = !p.some((c) => c.type === 'combinator');
    for (const c of child) {
      const selector = c.some(isNesting)
        ? c
        : [NESTING, { type: 'combinator', value: 'descendant' } as SelectorComponent, ...c];
      const out: Selector = [];
      selector.forEach((component, i) => {
        if (!isNesting(component)) {
          out.push(component);
          return;
        }
        const startsCompound = i === 0 || selector[i - 1].type === 'combinator';
        if (simple || startsCompound) out.push(...p);
        else out.push({ type: 'pseudo-class', kind: 'is', selectors: [p] } as SelectorComponent);
      });
      result.push(out);
    }
  }
  return result;
}

// Replaces every `&` (including inside `:is()` and similar) with a class.
export function withClass(selectors: SelectorList, className: string): SelectorList {
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') {
      if ((value as SelectorComponent).type === 'nesting')
        return { type: 'class', name: className };
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  };
  return replace(selectors) as SelectorList;
}

// LVHFA: `:link`, `:visited`, `:hover`, `:focus`, `:active`.
const LVHFA: Record<string, number> = {
  link: 0,
  'any-link': 0,
  visited: 1,
  hover: 2,
  focus: 3,
  'focus-within': 3,
  'focus-visible': 3,
  active: 4,
};

// Where a selector variant falls in LVHFA order: the highest-ranked
// pseudo-class it uses, or -1 when it uses none of them.
export function lvhfaRank(selectors: SelectorList): number {
  let rank = -1;
  for (const selector of selectors) {
    for (const c of selector) {
      if (c.type === 'pseudo-class' && c.kind in LVHFA) rank = Math.max(rank, LVHFA[c.kind]);
    }
  }
  return rank;
}

// Works around two Lightning CSS bugs that stop selectors from printing
// after they've been through the JS AST. Takes selectors, or a rule that
// contains them:
// - `:active-view-transition-type()` keeps its types in a field named
//   `type`, which clashes with the field that names the component's type,
//   so it can't be read back. It's rewritten as a generic functional
//   pseudo-class.
// - Number tokens in the arguments of functional pseudo-classes Lightning
//   CSS doesn't know (such as `:heading(2)`) lose whether they're integers,
//   and print as `2.0`. Integers are rewritten as one `delim` token per
//   character, which print as they are.
export function repair<T>(selectors: T): T {
  const fix = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fix);
    if (value === null || typeof value !== 'object') return value;
    const component = value as Record<string, any>;
    if (component.kind === 'active-view-transition-type' && Array.isArray(component.type)) {
      const types = component.type as string[];
      return {
        type: 'pseudo-class',
        kind: 'custom-function',
        name: 'active-view-transition-type',
        arguments: types.flatMap((name, i) => [
          ...(i > 0 ? [{ type: 'token', value: { type: 'comma' } }] : []),
          { type: 'token', value: { type: 'ident', value: name } },
        ]),
      };
    }
    if (component.kind === 'custom-function' && Array.isArray(component.arguments)) {
      return {
        ...component,
        arguments: component.arguments.flatMap((token: any) =>
          token.type === 'token' &&
          token.value.type === 'number' &&
          Number.isInteger(token.value.value)
            ? [...String(token.value.value)].map((ch) => ({
                type: 'token',
                value: { type: 'delim', value: ch },
              }))
            : [fix(token)],
        ),
      };
    }
    return Object.fromEntries(Object.entries(component).map(([k, v]) => [k, fix(v)]));
  };
  return fix(selectors) as T;
}

type Specificity = [ids: number, classes: number, types: number];

// A selector list's specificity: its most specific selector's.
export function specificity(selectors: SelectorList): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const selector of selectors) {
    const current = ofSelector(selector);
    const difference = current[0] - best[0] || current[1] - best[1] || current[2] - best[2];
    if (difference > 0) best = current;
  }
  return best;
}

function ofSelector(selector: Selector): Specificity {
  const total: Specificity = [0, 0, 0];
  const add = (other: Specificity) => {
    total[0] += other[0];
    total[1] += other[1];
    total[2] += other[2];
  };
  for (const component of selector as {
    type: string;
    kind?: string;
    selectors?: SelectorList;
    of?: SelectorList;
  }[]) {
    if (component.type === 'id') total[0]++;
    else if (component.type === 'class' || component.type === 'attribute') total[1]++;
    else if (component.type === 'type' || component.type === 'pseudo-element') total[2]++;
    else if (component.type === 'pseudo-class' && component.kind !== 'where') {
      // `:is()`, `:not()`, and `:has()` count as their most specific argument.
      if (component.selectors) add(specificity(component.selectors));
      else {
        total[1]++;
        if (component.of) add(specificity(component.of));
      }
    }
  }
  return total;
}
