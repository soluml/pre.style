import { onHostsChanged, readHosts } from './hosts.ts';
import { evaluate, fetchUsages } from './lookup.ts';
import { classesToFetch, hasRules } from './model.ts';
import { call, readSelected, SELECTED, whenAllowed } from './page.ts';
import type { Selected } from './page.ts';

chrome.devtools.panels.elements.createSidebarPane('pre.style', (pane) => {
  pane.setPage('pane.html');
});

// The toolbar icon is in color while the selected element has pre.style
// classes, whether or not the pane is open. The background script sets it,
// and grays it again when this port closes with DevTools.
const { tabId } = chrome.devtools.inspectedWindow;
let active = false;
let port: chrome.runtime.Port;
const connect = () => {
  port = chrome.runtime.connect({ name: 'devtools' });
  port.postMessage({ tabId, active });
  // Chrome stops an idle background service worker, which closes the port.
  port.onDisconnect.addListener(connect);
};
connect();

let extraHosts: string[] = [];
let checking = 0;

async function check() {
  const id = ++checking;
  let next = false;
  try {
    // Elsewhere, only the hostname is read, as in the pane.
    if (!(await evaluate<boolean>(whenAllowed('0', extraHosts)))) throw new Error('not local');
    const selected = await evaluate<Selected | null>(call(readSelected, SELECTED));
    const own = selected?.own ?? [];
    const classes = classesToFetch(own, []);
    if (classes.length > 0) {
      const lookup = await fetchUsages(classes, extraHosts);
      next = 'usages' in lookup && hasRules(lookup.usages.rules, own);
    }
  } catch {
    // Not a dev server, or the page is gone or can't be read: nothing to show.
  }
  // Only the latest check counts.
  if (id !== checking || next === active) return;
  active = next;
  port.postMessage({ tabId, active });
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(() => void check());
chrome.devtools.network.onNavigated.addListener(() => void check());
const loadHosts = () =>
  readHosts().then((hosts) => {
    extraHosts = hosts;
    void check();
  });
onHostsChanged(() => void loadHosts());
void loadHosts();
