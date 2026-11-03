export type Browser = 'chrome' | 'firefox';

// No permissions: everything goes through `inspectedWindow.eval`, so requests
// to the dev server are same-origin ones from the page.
export function manifest(browser: Browser, version: string, description: string) {
  return {
    manifest_version: 3,
    name: 'pre.style DevTools',
    version,
    description,
    homepage_url: 'https://pre.style',
    icons: { 128: 'icon.png' },
    devtools_page: 'devtools.html',
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
