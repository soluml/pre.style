// The parts of the DevTools extension API the extension uses. Firefox provides
// the same callbacks under `chrome`, and Chrome turns off the `browser`
// namespace for extensions with a `devtools_page`.
declare namespace chrome.devtools {
  namespace inspectedWindow {
    const tabId: number;
    // oxlint-disable-next-line no-shadow-restricted-names
    function eval(
      expression: string,
      callback: (result: unknown, exception?: { value?: string; code?: string }) => void,
    ): void;
  }
  namespace network {
    const onNavigated: { addListener(listener: () => void): void };
  }
  namespace panels {
    const themeName: string;
    const elements: {
      onSelectionChanged: { addListener(listener: () => void): void };
      createSidebarPane(
        title: string,
        callback: (pane: {
          setPage(path: string): void;
          onShown: { addListener(listener: () => void): void };
        }) => void,
      ): void;
    };
  }
}

declare namespace chrome.runtime {
  const lastError: { message?: string } | undefined;
  function openOptionsPage(): void;
  interface Port {
    name: string;
    postMessage(message: unknown): void;
    onMessage: { addListener(listener: (message: unknown) => void): void };
    onDisconnect: { addListener(listener: () => void): void };
  }
  function connect(info: { name: string }): Port;
  const onConnect: { addListener(listener: (port: Port) => void): void };
}

// Only in the background script.
declare namespace chrome.action {
  function enable(tabId?: number): Promise<void>;
  function disable(tabId?: number): Promise<void>;
}

// Missing if a browser doesn't offer it to DevTools pages.
declare namespace chrome {
  const storage:
    | {
        local: {
          get(key: string, callback: (items: Record<string, unknown> | undefined) => void): void;
          set(items: Record<string, unknown>, callback: () => void): void;
        };
        onChanged: {
          addListener(listener: (changes: Record<string, unknown>, area: string) => void): void;
        };
      }
    | undefined;
}
