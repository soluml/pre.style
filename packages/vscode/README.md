# pre.style for VS Code

Editor support for [pre.style](https://pre.style), the zero-runtime CSS-in-JS tool that compiles `css` and `scss` blocks into atomic CSS classes.

## Features

### Color coding in blocks

`` css` `` and `` scss` `` tagged templates are colored as CSS and SCSS, including nesting, at-rules, custom properties, and Sass variables. Blocks are recognized in:

- JavaScript, TypeScript, JSX, and TSX files
- Astro frontmatter, template expressions such as ``class={css`…`}``, and `<script>` tags (with the [Astro extension](https://marketplace.visualstudio.com/items?itemName=astro-build.astro-vscode) installed)
- HTML `class` attributes, such as ``class="css`…`"``, and `<script>` tags

Inside a block, toggling a comment inserts `/* … */`, and `${…}` is colored as JavaScript.

### CSS completion in blocks

Property names, values, pseudo-classes, at-rules, and Sass variables are completed inside blocks, with the same data and documentation as VS Code's CSS support. Completion follows your `css.completion.*` settings in `css` blocks and your `scss.completion.*` settings in `scss` blocks:

- `triggerPropertyValueCompletion`: suggest values after you pick a property
- `completePropertyWithSemicolon`: add a semicolon after a completed property

### The `pre.style` field in `package.json`

The `pre.style` field in `package.json` is validated, with completion and descriptions for each option. You don't need to add anything to the `json.schemas` setting.

### TypeScript setup

Run **pre.style: Set Up TypeScript Types** from the Command Palette to type stylesheet imports (`import { button } from './button.css' with { type: 'pre.style' }`) in every TypeScript project that uses pre.style:

- **TypeScript 7.1 and later:** adds pre.style's content mapper to `tsconfig.json`, keeping its comments and formatting. It then offers to remove `declare module "*.css"` and `"*.scss"` declarations, which TypeScript would prefer over the mapper.
- **Earlier versions:** adds a `stylesheets.d.ts` declaration, which types namespace imports (`import * as styles from './button.css' with { type: 'pre.style' }`).

When you open a file that imports a stylesheet in a project that isn't set up, the extension offers to set it up.

Content mappers run code from a package, so `tsc` needs the `--runExternalCode` flag, and VS Code needs the workspace to be trusted.

## Install

In VS Code, open the Extensions view (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>, or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS), search for **pre.style**, and select **Install**.

Or install it from a terminal:

```sh
code --install-extension pre-style.pre-style
```

To install a `.vsix` file instead, run **Extensions: Install from VSIX…** from the Command Palette and pick the file, or run:

```sh
code --install-extension path/to/pre-style.vsix
```

## Uninstall

In the Extensions view, find **pre.style**, open its gear menu, and select **Uninstall**.

Or uninstall it from a terminal:

```sh
code --uninstall-extension pre-style.pre-style
```

Uninstalling leaves your project files as they are, including any `tsconfig.json` and declaration changes made by **pre.style: Set Up TypeScript Types**.

## Known limitations

- Blocks are found by their tag, so they must use the `css` or `scss` name: a renamed import (`import { css as style }`) isn't recognized.
- `${…}` in a block is only colored and skipped by completion. The extension adds no other JavaScript features there.
- While you type a `{` without its closing `}`, the rest of the file is colored as CSS until you close it.
- The [styled-components extension](https://marketplace.visualstudio.com/items?itemName=styled-components.vscode-styled-components) also colors `` css` `` templates. If you have both installed, either may color a block.

## Links

- [Documentation](https://github.com/soluml/pre.style#readme)
- [Report an issue](https://github.com/soluml/pre.style/issues)
