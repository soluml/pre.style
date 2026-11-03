// The parts of the DevTools extension API the extension uses. Firefox provides
// the same callbacks under `chrome`, and Chrome turns off the `browser`
// namespace for extensions with a `devtools_page`.
declare namespace chrome.devtools {
  namespace inspectedWindow {
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
