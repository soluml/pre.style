import { normalizeHost, readHosts, writeHosts } from './hosts.ts';

const form = document.querySelector<HTMLFormElement>('#add')!;
const input = document.querySelector<HTMLInputElement>('#host')!;
const error = document.querySelector<HTMLElement>('#error')!;
const list = document.querySelector<HTMLElement>('#hosts')!;

let hosts: string[] = [];

function render() {
  list.replaceChildren(
    ...hosts.map((host) => {
      const item = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = host;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${host}`);
      remove.addEventListener('click', () => {
        void save(hosts.filter((other) => other !== host));
      });
      item.append(name, remove);
      return item;
    }),
  );
}

async function save(next: string[]) {
  try {
    await writeHosts(next);
    hosts = next;
    error.textContent = '';
    render();
  } catch (failure) {
    error.textContent = `Couldn’t save: ${String(failure)}`;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const host = normalizeHost(input.value);
  if (host === null) {
    error.textContent = `“${input.value.trim()}” isn’t a hostname.`;
    return;
  }
  input.value = '';
  void save(hosts.includes(host) ? hosts : [...hosts, host].toSorted());
});

void readHosts().then((stored) => {
  hosts = stored;
  render();
});
