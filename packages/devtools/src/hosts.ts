const STORAGE_KEY = 'allowedHosts';

// Turns what someone typed into a hostname, or `*.` and a hostname, or null if
// it isn't one. A pasted URL or a port is reduced to the hostname.
export function normalizeHost(input: string): string | null {
  const text = input.trim().toLowerCase();
  const wildcard = text.startsWith('*.');
  const rest = wildcard ? text.slice(2) : text;
  if (rest === '' || /\s/.test(rest)) return null;
  let hostname: string;
  try {
    hostname = new URL(rest.includes('://') ? rest : `http://${rest}`).hostname;
  } catch {
    return null;
  }
  if (hostname === '' || hostname.includes('*')) return null;
  return wildcard ? `*.${hostname}` : hostname;
}

// Fails closed: if settings can't be read, only built-in local hostnames work.
export const readHosts = () =>
  new Promise<string[]>((resolve) => {
    if (chrome.storage?.local === undefined) {
      resolve([]);
      return;
    }
    chrome.storage.local.get(STORAGE_KEY, (items) => {
      const hosts = chrome.runtime.lastError ? [] : items?.[STORAGE_KEY];
      resolve(Array.isArray(hosts) ? hosts.filter((host) => typeof host === 'string') : []);
    });
  });

export const writeHosts = (hosts: string[]) =>
  new Promise<void>((resolve, reject) => {
    chrome.storage!.local.set({ [STORAGE_KEY]: hosts }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });

export const onHostsChanged = (listener: () => void) => {
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) listener();
  });
};
