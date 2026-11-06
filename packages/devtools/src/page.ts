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
  // Where its class attribute is written (`path:line:column`, relative to the
  // app), and where a component it's in was given one, from attributes the
  // dev server adds.
  at: string | null;
  from: string | null;
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
  return {
    label: `${element.localName}${id}${classes}`,
    own,
    context: [...context],
    at: element.getAttribute?.('data-pre-style-at') ?? null,
    from: element.getAttribute?.('data-pre-style-from') ?? null,
  };
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
      // Lightning CSS writes the older `:before` form, which works the same.
      return element.matches(
        selector.replace(/::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)\b/g, ''),
      );
    } catch {
      return false;
    }
  });
}

// A rule the runtime inserted for a value in a `${…}`. These aren't in the CSS
// file, so the dev server doesn't know them, and only the page has them.
export interface Generated {
  className: string;
  selector: string;
  property: string;
  value: string;
  specificity: [number, number, number];
  // Its place in the runtime's stylesheet. Later rules win.
  index: number;
}

// The generated rules for these classes, from the page's adopted stylesheets,
// which is where the runtime puts them.
export function readGenerated(classes: string[]): Generated[] {
  const wanted = new Set(classes);
  const found: Generated[] = [];
  let index = 0;
  for (const sheet of document.adoptedStyleSheets ?? []) {
    for (const rule of sheet.cssRules) {
      const position = index++;
      const { selectorText: selector, style } = rule as CSSStyleRule;
      const className = /\.(_[\w-]+)/.exec(selector ?? '')?.[1];
      const property = style?.[0];
      if (className === undefined || !wanted.has(className) || !property?.startsWith('--'))
        continue;
      // Selectors the runtime writes have no strings, so these can be counted.
      const bare = selector.replace(/:[:\w-]*\(/g, (match) => match.slice(0, -1) + ' ');
      const ids = (bare.match(/#[\w-]+/g) ?? []).length;
      const elements =
        (bare.match(/::[\w-]+/g) ?? []).length +
        (bare.match(/(?:^|[\s>+~,(])[a-zA-Z][\w-]*/g) ?? []).length;
      const others = (bare.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
      found.push({
        className,
        selector,
        property,
        value: style.getPropertyValue(property).trim(),
        specificity: [ids, others, elements],
        index: position,
      });
    }
  }
  return found;
}

// Whether the pane may run on a page: its hostname is this computer, or one the
// user listed in the settings. Nothing else is built in, even private names like
// `.test` or `192.168.…`, since they can't be told from a deployed site.
export function isAllowedHost(hostname: string, extra: string[] = []): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    extra.some((entry) =>
      entry.startsWith('*.') ? hostname.endsWith(entry.slice(1)) : hostname === entry,
    )
  );
}

// An expression that runs another one only on an allowed page, and says whether
// it did. The check is part of the same evaluation, so a navigation can't slip
// between the two and send a request to another site.
export const whenAllowed = (expression: string, extra: string[]) =>
  `${call(isAllowedHost, LOCATION_HOSTNAME, extra)} ? (${expression}, true) : false`;

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

// An expression that calls a page function with JSON arguments. `$0` and the
// hostname are passed as written, since they're only known in the page.
export const call = (fn: (...args: never[]) => unknown, ...args: unknown[]) =>
  `(${fn.toString()})(${args.map(argument).join(',')})`;
const argument = (arg: unknown) =>
  arg === SELECTED ? '$0' : arg === LOCATION_HOSTNAME ? 'location.hostname' : JSON.stringify(arg);
export const SELECTED = Symbol('$0');
const LOCATION_HOSTNAME = Symbol('location.hostname');
