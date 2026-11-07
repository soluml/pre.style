import type { Usages } from './model.ts';
import { call, startFetch, takeFetched, whenAllowed } from './page.ts';

const USAGES_URL = '/__pre.style/usages';
const USAGES_VERSION = 1;
const FETCH_TIMEOUT = 5000;

export const evaluate = <T>(expression: string) =>
  new Promise<T>((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exception) => {
      if (exception) reject(new Error(exception.value ?? exception.code ?? 'eval failed'));
      else resolve(result as T);
    });
  });

export type Lookup = { usages: Usages } | { problem: 'not-local' | 'no-server' | 'outdated' };

let fetches = 0;

// Asks the inspected page's dev server where `classes` are used, through the
// page, only on allowed hosts (`extraHosts` are the settings' hostnames).
export async function fetchUsages(classes: string[], extraHosts: string[]): Promise<Lookup> {
  const id = `f${++fetches}`;
  const url = `${USAGES_URL}?classes=${classes.map(encodeURIComponent).join(',')}`;
  if (!(await evaluate<boolean>(whenAllowed(call(startFetch, id, url), extraHosts))))
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
