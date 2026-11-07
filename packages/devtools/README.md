# pre.style DevTools

A side pane for the browser's Elements panel that traces [pre.style](https://pre.style) classes back to their source.

pre.style's classes are shared, so `color: red` is one class no matter how many files use it. A source map can only point to one place, so the Styles pane links to just one of those files. This pane links to all of them.

## What it shows

Select an element, then open the **pre.style** tab next to Styles. If the tab isn't visible, it's in the `»` overflow menu.

- **Class attribute:** where the element got its classes. **Passed in** is the `className` or `class` given to a component (`<Button className={…}>`), and **On the element** is the one on the element itself (`<button className={…}>`). Click one to open it in your editor.
- **Applied:** the rules that apply to the element, most important first. Rules that lose to another rule for the same property are crossed out.
- **Pseudo-elements:** rules for `::before` and the like, each in its own group.
- **Not applied right now:** rules from the element's classes that don't apply at the moment, such as `:hover` or a media query that doesn't match.
- **Runtime values:** for a `${…}`, the rule the runtime generated for its current value, marked **Set at runtime**, so you can see what `var(--A)` holds. Its sources are the rules that read its variable. A value set on another element, such as a parent, appears when it reaches the selected one.
- **Sources:** every place each rule is used. Click one to open it in your editor.
- **Order of sources:** files using the most of the element's classes come first, since they're the most likely to have produced it, then alphabetically. This is a best guess: a file with many blocks can rank high too.
- **Filter:** searches selectors, declarations, at-rules, and file paths.
- **Toolbar icon:** in color while DevTools is open on a tab and the selected element has pre.style classes, gray otherwise, whether or not the pane is open.

## Requirements

- Chrome (or another Chromium browser) or Firefox 140 or later
- `@pre.style/vite` with the same version of this extension, running Vite's dev server, with the `sourceMap` option on (the default in dev)
- For the **Class attribute** section: the plugin's `sourceAttributes` option, on by default in dev. It adds `data-pre-style-at` and `data-pre-style-from` attributes to your JSX and Astro components in dev, never in builds, and in test runs (Vite's `test` mode, as in Vitest) only if you set it to `true`.

The extension's only permission is `storage`, for its settings. It reads from the page you're inspecting, and that page asks its own dev server.

It only runs on your own computer: `localhost`, `*.localhost`, and loopback addresses such as `127.0.0.1`. Browsers can't limit a DevTools extension to certain sites, so the tab still appears everywhere, but on other sites it only reads the page's hostname and sends no requests.

## Other hostnames

If your dev server uses another name, add it in the extension's settings, through **Add a hostname** in the pane or the extension's options page. Entries can be a hostname (`app.test`), an IP address (`192.168.1.5`), or a wildcard (`*.test`, which matches `a.test` but not `test`). They're stored in this browser only.

The pane sends requests to every hostname listed, so only add dev servers. For a name other than an IP address, Vite's [`server.allowedHosts`](https://vite.dev/config/server-options#server-allowedhosts) option also needs to include it, or the pane reports that there's no dev server.

## Install from source

Run `npm run build -w packages/devtools`, which writes one folder per browser to `packages/devtools/dist`.

- **Chrome:** go to `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `dist/chrome`.
- **Firefox:** go to `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`.

## Limitations

- **Files that haven't been compiled yet:** dev compiles files as they're requested, so pages you haven't opened may be missing from the list.
- **Rules, not declarations:** a location points to the rule a declaration is in, so a declaration directly in a block links to the start of the block.
- **Only pre.style's rules:** global rules (`:root`, `body`), other stylesheets, inline styles, and inherited properties aren't listed. Crossed-out rules only consider other pre.style rules, so the Styles pane is still the word on the full cascade.
- **Layers:** `@layer` order is approximated by output order.
- **Conditions it can't check:** rules in `@container` and similar at-rules count as applied.
- **Class attribute:** only JSX and Astro components are marked, in files that mention `pre.style`, so plain HTML and other template languages have no section. In Astro, `class:list` counts too, but an element's `{...attrs}` spread doesn't. **Passed in** only reaches the element if the component passes its props on (`{...props}`); with several components in between, the last one to do so wins.
- **Opening files** uses Vite's `/__open-in-editor` route. When the dev server runs in VS Code's terminal, the plugin defaults the `LAUNCH_EDITOR` environment variable to `code`. Elsewhere, Vite guesses your editor, so set `LAUNCH_EDITOR` yourself if it opens the wrong one.
