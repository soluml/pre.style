// The toolbar icon is gray (disabled) except in tabs whose DevTools have an
// element with pre.style classes selected. Each DevTools window keeps a port
// open and says when that changes.
chrome.action.disable();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'devtools') return;
  let tabId: number | undefined;
  port.onMessage.addListener((message) => {
    const { tabId: id, active } = message as { tabId: number; active: boolean };
    tabId = id;
    void (active ? chrome.action.enable(id) : chrome.action.disable(id)).catch(() => {});
  });
  // DevTools closed, or its page reloaded. Ports also close when Chrome stops
  // this service worker, but then the DevTools page reconnects and says again.
  port.onDisconnect.addListener(() => {
    if (tabId !== undefined) void chrome.action.disable(tabId).catch(() => {});
  });
});
