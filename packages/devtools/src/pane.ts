import { buildView, classesToFetch, editorUrl, fileCount, location } from './model.ts';
import type { Rule, ShownRule, Source, Usages } from './model.ts';
import {
  call,
  matchRules,
  readSelected,
  SELECTED,
  startFetch,
  takeFetched,
  whenLocal,
} from './page.ts';
import type { Selected } from './page.ts';

const USAGES_URL = '/__pre.style/usages';
const USAGES_VERSION = 1;
const FETCH_TIMEOUT = 5000;
// Sources shown for a rule before the rest are folded away.
const SOURCES_SHOWN = 5;

const evaluate = <T>(expression: string) =>
  new Promise<T>((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exception) => {
      if (exception) reject(new Error(exception.value ?? exception.code ?? 'eval failed'));
      else resolve(result as T);
    });
  });

type Lookup = { usages: Usages } | { problem: 'not-local' | 'no-server' | 'outdated' };

let fetches = 0;

async function fetchUsages(classes: string[]): Promise<Lookup> {
  const id = `f${++fetches}`;
  const url = `${USAGES_URL}?classes=${classes.map(encodeURIComponent).join(',')}`;
  if (!(await evaluate<boolean>(whenLocal(call(startFetch, id, url)))))
    return { problem: 'not-local' };
  const deadline = Date.now() + FETCH_TIMEOUT;
  while (Date.now() < deadline) {
    const result = await evaluate<ReturnType<typeof takeFetched>>(call(takeFetched, id));
    if (result !== null) {
      if ('error' in result || result.status !== 200 || !result.type?.includes('json'))
        return { problem: 'no-server' };
      const usages = JSON.parse(result.body) as Usages;
      return usages.version === USAGES_VERSION ? { usages } : { problem: 'outdated' };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { problem: 'no-server' };
}

const content = document.querySelector<HTMLElement>('#content')!;
const label = document.querySelector<HTMLElement>('#label')!;
const filterInput = document.querySelector<HTMLInputElement>('#filter')!;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(title: string, detail: string) {
  const box = element('div', 'message');
  box.append(element('p', 'message-title', title), element('p', 'message-detail', detail));
  content.replaceChildren(box);
}

function sourceLink(source: Source, editor: string) {
  const link = element('button', 'source', location(source));
  link.type = 'button';
  link.title = `Open ${source.file} in your editor`;
  link.addEventListener('click', () => {
    void evaluate(whenLocal(`fetch(${JSON.stringify(editorUrl(editor, source))})`));
  });
  return link;
}

function sourceList(rule: Rule, editor: string) {
  const box = element('div', 'sources');
  const count = fileCount(rule.sources);
  if (rule.sources.length === 0) {
    box.append(element('span', 'source-none', 'Not used in the current code'));
    return box;
  }
  box.append(element('span', 'source-count', count === 1 ? '1 file' : `${count} files`));
  const links = rule.sources.map((source) => sourceLink(source, editor));
  box.append(...links.slice(0, SOURCES_SHOWN));
  if (links.length > SOURCES_SHOWN) {
    const more = element('details', 'source-more');
    more.append(element('summary', '', `${links.length - SOURCES_SHOWN} more`));
    more.append(...links.slice(SOURCES_SHOWN));
    box.append(more);
  }
  return box;
}

function ruleCard(rule: Rule & Partial<ShownRule>, editor: string) {
  const card = element('article', rule.overridden ? 'rule overridden' : 'rule');
  for (const atRule of rule.atRules) card.append(element('div', 'at-rule', atRule));
  const code = element('div', 'code');
  code.append(element('span', 'selector', rule.selector), element('span', 'brace', ' {'));
  const line = element('div', 'declaration');
  const [property, ...value] = rule.declaration.split(':');
  line.append(
    element('span', 'property', property),
    element('span', 'punctuation', ':'),
    element('span', 'value', value.join(':')),
    element('span', 'punctuation', ';'),
  );
  if (rule.overridden) line.title = 'Overridden by a rule above';
  code.append(line, element('span', 'brace', '}'));
  card.append(code, sourceList(rule, editor));
  return card;
}

function section(title: string, cards: HTMLElement[], className = '') {
  const box = element('section', `group ${className}`);
  box.append(element('h2', 'group-title', title), ...cards);
  return box;
}

interface State {
  selected: Selected | null;
  lookup: Lookup | null;
  matched: boolean[];
}

const state: State = { selected: null, lookup: null, matched: [] };
// What's on screen. Refreshes usually change nothing, and rebuilding the DOM
// would lose hover, open folds, and a click in progress.
let rendered = '';

function render() {
  const { selected, lookup, matched } = state;
  const next = JSON.stringify([selected, lookup, matched, filterInput.value]);
  if (next === rendered) return;
  rendered = next;
  label.textContent = selected?.label ?? '';
  if (lookup !== null && 'problem' in lookup && lookup.problem === 'not-local') {
    label.textContent = '';
    message(
      'Only for local dev servers',
      'This site isn’t on your computer, so the pane sends it no requests. It works on localhost, *.localhost, and loopback addresses.',
    );
    return;
  }
  if (selected === null) {
    message('No element selected', 'Select an element in the Elements panel.');
    return;
  }
  if (lookup === null) return;
  if ('problem' in lookup) {
    if (lookup.problem === 'outdated')
      message(
        'Update pre.style',
        'This extension and your @pre.style/vite version don’t match. Update both to their latest versions.',
      );
    else
      message(
        'No pre.style dev server here',
        'This pane works with the Vite dev server, with @pre.style/vite’s sourceMap option on. It can’t read production builds.',
      );
    return;
  }
  const { usages } = lookup;
  const view = buildView(usages.rules, matched, selected.own, filterInput.value);
  const { editor } = usages;
  const groups: HTMLElement[] = [];
  if (view.applied.length > 0)
    groups.push(
      section(
        'Applied',
        view.applied.map((rule) => ruleCard(rule, editor)),
      ),
    );
  for (const { name, rules } of view.pseudo)
    groups.push(
      section(
        `Pseudo-element ${name}`,
        rules.map((rule) => ruleCard(rule, editor)),
      ),
    );
  if (view.inactive.length > 0)
    groups.push(
      section(
        'Not applied right now',
        view.inactive.map((rule) => ruleCard(rule, editor)),
        'inactive',
      ),
    );
  if (groups.length === 0) {
    message(
      filterInput.value.trim() ? 'No matching rules' : 'No pre.style classes',
      filterInput.value.trim()
        ? 'Nothing here matches the filter.'
        : 'Nothing on this element comes from a pre.style class.',
    );
    return;
  }
  groups.push(
    element(
      'p',
      'note',
      'Lists files the dev server has compiled so far, so pages you haven’t opened may be missing. Overrides only consider pre.style rules: check Styles for the full cascade.',
    ),
  );
  content.replaceChildren(...groups);
}

let running: Promise<void> | null = null;
let again = false;

async function refresh() {
  if (!(await evaluate<boolean>(whenLocal('0')))) {
    state.selected = null;
    state.lookup = { problem: 'not-local' };
    render();
    return;
  }
  const selected = await evaluate<Selected | null>(call(readSelected, SELECTED));
  state.selected = selected;
  if (selected === null) {
    state.lookup = null;
    render();
    return;
  }
  const classes = classesToFetch(selected.own, selected.context);
  state.lookup = await fetchUsages(classes);
  state.matched =
    'usages' in state.lookup
      ? await evaluate<boolean[]>(
          call(
            matchRules,
            SELECTED,
            state.lookup.usages.rules.map(({ selector, atRules }) => ({ selector, atRules })),
          ),
        )
      : [];
  render();
}

// One at a time, with one more if something asked in the meantime, so a slow
// answer can't replace a newer one.
function requestRefresh() {
  if (running !== null) {
    again = true;
    return;
  }
  running = refresh()
    .catch((error: unknown) => {
      rendered = '';
      message('Couldn’t read this page', String(error));
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        requestRefresh();
      }
    });
}

document.documentElement.dataset.theme =
  chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';
filterInput.addEventListener('input', render);
document.querySelector('#refresh')!.addEventListener('click', requestRefresh);
// Back from the editor or from toggling an element's state, where nothing else
// says that the answer may have changed.
document.documentElement.addEventListener('pointerenter', requestRefresh);
window.addEventListener('focus', requestRefresh);
chrome.devtools.panels.elements.onSelectionChanged.addListener(requestRefresh);
chrome.devtools.network.onNavigated.addListener(requestRefresh);
requestRefresh();
