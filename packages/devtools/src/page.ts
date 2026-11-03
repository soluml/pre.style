import type { Rule } from './model.ts';

// These run in the inspected page, serialized with `toString()`, so they can't
// use anything from outside themselves.

export interface Selected {
  // How the Elements panel would name the element, such as `div#a.b`.
  label: string;
  // Its classes.
  own: string[];
  // Classes of the elements a selector could go through to reach it: its
  // ancestors, and their and its earlier siblings.
  context: string[];
}

export function readSelected(element: Element | null | undefined): Selected | null {
  if (!element || !element.classList) return null;
  const own = [...element.classList];
  const context = new Set<string>();
  let budget = 2000;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current !== element) for (const name of current.classList) context.add(name);
    let sibling = current.previousElementSibling;
    while (sibling && budget-- > 0) {
      for (const name of sibling.classList) context.add(name);
      sibling = sibling.previousElementSibling;
    }
  }
  const id = element.id ? `#${element.id}` : '';
  const classes = own.map((name) => `.${name}`).join('');
  return { label: `${element.localName}${id}${classes}`, own, context: [...context] };
}

// Whether each rule currently applies to the element. A rule for a pseudo-element
// counts if its element matches. Container queries and the like can't be
// checked from here, so they count as applying.
export function matchRules(
  element: Element | null | undefined,
  rules: Pick<Rule, 'selector' | 'atRules'>[],
): boolean[] {
  return rules.map(({ selector, atRules }) => {
    if (!element) return false;
    for (const atRule of atRules) {
      const [, name, condition] = /^@([\w-]+)\s*(.*)$/s.exec(atRule) ?? [];
      if (name === 'starting-style') return false;
      if (name === 'media' && !matchMedia(condition).matches) return false;
      if (name === 'supports' && !CSS.supports(condition)) return false;
    }
    try {
      return element.matches(selector.replace(/::[\w-]+(?:\([^)]*\))?/g, ''));
    } catch {
      return false;
    }
  });
}

interface Fetched {
  status: number;
  type: string | null;
  body: string;
}

// `eval` can't wait for a promise, so the page keeps the response under an ID
// for `takeFetched` to collect.
export function startFetch(id: string, url: string): void {
  const store = window as unknown as { preStyleDevtools?: Record<string, unknown> };
  const pending = (store.preStyleDevtools ??= {});
  fetch(url, { headers: { accept: 'application/json' } })
    .then(async (response) => {
      pending[id] = {
        status: response.status,
        type: response.headers.get('content-type'),
        body: await response.text(),
      };
    })
    .catch((error) => {
      pending[id] = { error: String(error) };
    });
}

export function takeFetched(id: string): Fetched | { error: string } | null {
  const pending = (window as unknown as { preStyleDevtools?: Record<string, never> })
    .preStyleDevtools;
  const result = pending?.[id] ?? null;
  if (result !== null) delete pending![id];
  return result;
}

// An expression that calls a page function with JSON arguments. `$0` is passed
// as written, since only the DevTools console has it.
export const call = (fn: (...args: never[]) => unknown, ...args: unknown[]) =>
  `(${fn.toString()})(${args.map((arg) => (arg === SELECTED ? '$0' : JSON.stringify(arg))).join(',')})`;
export const SELECTED = Symbol('$0');
