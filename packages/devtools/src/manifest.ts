export type Browser = 'chrome' | 'firefox';

// Only `storage`, for the settings: everything else goes through
// `inspectedWindow.eval`, so requests to the dev server are same-origin ones from
// the page.
export function manifest(browser: Browser, version: string, description: string) {
  return {
    manifest_version: 3,
    name: 'pre.style DevTools',
    version,
    description,
    homepage_url: 'https://pre.style',
    icons: { 128: 'icon.png' },
    // Gray unless the selected element has pre.style classes.
    action: { default_icon: { 128: 'icon.png' }, default_title: 'pre.style DevTools' },
    // Chrome runs it as a service worker, Firefox as an event page.
    background:
      browser === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    devtools_page: 'devtools.html',
    options_ui: { page: 'options.html' },
    permissions: ['storage'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'devtools@pre.style',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  };
}
