# pre.style

[![npm version](https://img.shields.io/npm/v/@pre.style/core/next)](https://www.npmjs.com/package/@pre.style/core)

Zero-runtime CSS-in-JS. Write plain CSS or SCSS next to your markup, and pre.style compiles it at build time into atomic CSS classes: one small class per declaration, shared across your whole project.

```js
import { css } from "@pre.style/core";

const button = css`
  background-color: #0071ba;
  color: white;
  padding-block: 0.5em;

  &:hover {
    background-color: #005a94;
  }

  @media (min-width: 768px) {
    padding-block: 1em;
  }
`;
```

After the build, `button` is a plain string, `"B C E D A G F"`. The block is replaced, and these classes are added to a single CSS file:

```css
.B {
  background-color: #0071ba;
}
.C {
  color: #fff;
}
.E {
  padding-block-start: 0.5em;
}
.D {
  padding-block-end: 0.5em;
}
.A:hover {
  background-color: #005a94;
}
@media (width>=768px) {
  .G {
    padding-block-start: 1em;
  }
  .F {
    padding-block-end: 1em;
  }
}
```

- **No runtime by default.** Blocks are replaced with class strings during the build, and nothing is shipped to parse or inject CSS. The exception is [runtime values](#runtime-values), which you opt in to by writing `${…}`.
- **Small CSS.** Each declaration is written once, however many components use it, so the CSS file grows slowly as your project grows.
- **Just CSS.** Blocks are standard CSS (with nesting) or SCSS. There's no new syntax to learn.
- **Fast.** Built on [Lightning CSS](https://lightningcss.dev/). Every block is parsed once, in one process.

## Getting started

pre.style works with [Vite](https://vite.dev/). It needs Node 24 or later and Vite 8.

```sh
npm install @pre.style/core
npm install --save-dev @pre.style/vite lightningcss
```

To write SCSS blocks, also install Sass:

```sh
npm install --save-dev sass
```

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import preStyle from "@pre.style/vite";

export default defineConfig({
  plugins: [preStyle()],
});
```

Then import `css` (or `scss`) from `@pre.style/core` and use the class strings:

```jsx
import { css } from "@pre.style/core";

export function Card({ children }) {
  return (
    <div
      className={css`
        border-radius: 8px;
        padding: 1rem;
      `}
    >
      {children}
    </div>
  );
}
```

In a build, the plugin writes `pre.style.css` to your output directory and links it from `index.html`. In dev, the CSS is served by Vite and updates as you edit.

You can also write styles in `.css` and `.scss` files and import their classes, like CSS Modules. See [Stylesheet files](#stylesheet-files).

### Frameworks without `index.html`

Frameworks that render on the server, such as React Router's framework mode, don't use `index.html`. Import pre.style's CSS in your root module instead:

```ts
import "virtual:pre.style.css";
```

Vite then bundles the CSS with your app's other CSS, and the framework links it when rendering on the server, both in builds and in dev. The plugin doesn't write `output.file` when the CSS is imported this way.

### Astro

Add the plugin to Astro's Vite config, and import the CSS in your layout's frontmatter:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import preStyle from "@pre.style/vite";

export default defineConfig({
  vite: { plugins: [preStyle()] },
});
```

```astro
---
import { css } from '@pre.style/core';
import 'virtual:pre.style.css';

const title = css`
  font-size: 2rem;
`;
---

<h1 class={title}>Hello</h1>
```

Blocks work in frontmatter, in template expressions such as ``class={css`…`}``, in `<script>` tags, and in the islands of any framework. Astro links the CSS on every page that uses the layout, prerendered or rendered on demand. Astro compiles components before the plugin sees them, but errors and source maps still point to the component.

## Writing blocks

A block styles one element. Each block is treated as its own small stylesheet, where declarations at the top level apply to the element.

### `css` and `scss`

`css` blocks are plain CSS. `scss` blocks are compiled with Sass first, so you can use variables, mixins, functions, and everything else Sass supports:

```js
import { scss } from "@pre.style/core";

const title = scss`
  $size: 2rem;
  font-size: $size;
  margin-bottom: $size / 2;
`;
```

### Runtime values

Use `${…}` for values that are only known while your app runs, such as props:

```jsx
function Bar({ width }) {
  const bar = css`
    width: ${width}px;
  `;
  return <div className={bar} />;
}
```

Each `${…}` becomes a custom property, and the block's CSS is still written to the CSS file during the build:

```css
@property --A {
  syntax: "*";
  inherits: false;
}

.A {
  width: var(--A);
}
```

In the browser, a small runtime generates one class for each distinct value and inserts its rule once. `bar` is still a plain string, `"A _A3fK9"`, so it works anywhere a class string does, including `cn`.

```css
._A3fK9 {
  --A: 240px;
}
```

> [!IMPORTANT]
> **`${…}` adds JavaScript to your bundle.** It's the one part of pre.style with a runtime, and only apps that use `${…}` load it. Everything else stays static, so use `${…}` only for values that change at runtime. For constants, such as design tokens, use [Sass or prepended files](#sharing-values-with-prepended-files), which cost nothing in the browser. `${tokens.red}` uses the runtime, even though its value never changes.

The generated `@property` keeps the variable from inheriting. Variables are shared by every block with the same declaration, so without it, an element with no value of its own would take its parent's.

#### Default values

Write `var()` around a value to give it a default:

```js
css`
  width: var(${width}px, 120px);
  color: var(${color}, currentColor);
  background-color: var(${color}, var(--surface));
`;
```

```css
.A {
  width: var(--A, 120px);
}
```

The default can be any CSS. It's used when the value is `null` or `undefined`, in which case no class is generated, and until the runtime sets the value in the browser (see [Server rendering](#server-rendering)). A value of the wrong type doesn't use it: `width: var(${"red"}, 120px)` resets `width`. To catch those, use [`type()`](#typed-values-with-type).

#### Several values

Each `${…}` and the text touching it is one value, with its own variable:

```js
css`
  color: #${hex};
  margin-top: calc(${gap}px * 2);
  background-image: linear-gradient(${from}, ${to});
`;
```

Values inside one `var()` share a variable, and so share a default:

```js
css`
  margin: var(${y}px ${x}px, auto);
`;
```

```css
.A {
  margin: var(--A, auto);
}
```

Values work in nested selectors too, including pseudo-elements and other elements. The generated class's rule uses the same selector, so the value reaches them. `content` needs a string, so pass one:

```js
css`
  &::before {
    content: var(${JSON.stringify(String(count))}, "0");
  }

  & > * {
    margin-top: ${gap}px;
  }

  & + li {
    color: ${color};
  }
`;
```

```css
/* Inserted by the runtime */
._A3fK9::before {
  --A: "5";
}
```

#### Custom properties

A custom property set directly on the element is set by name. It needs no generated variable or `@property`, only the generated class:

```js
const badge = css`
  --brand: ${color};
  color: var(--brand);
`;
```

```css
.A {
  color: var(--brand);
}

/* Inserted by the runtime */
._B7xQ2 {
  --brand: #00f;
}
```

To give it a default, write `var()` around the value, or register it with `@property`, whose `initial-value` is the default. Write the rule yourself for full control, such as `inherits: true`:

```js
css`
  @property --brand {
    syntax: "<color>";
    inherits: false;
    initial-value: #f00;
  }

  --brand: ${color};
  color: var(--brand);
`;
```

With `inherits: true`, an element with no value of its own takes its parent's rather than the `initial-value`.

#### Typed values with `type()`

Add `type()` to say what kind of value a variable holds, the same way as in [`attr()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/attr). It takes any [`@property` syntax](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@property/syntax):

```js
css`
  width: var(${width}px type(<length>), 120px);
  height: var(${height} type(<length> | auto), auto);
  border-color: var(${color} type(<color>), red);
  translate: var(${x}px ${y}px type(<length>+), 0px);
`;
```

The default moves to the variable's `initial-value`, and the variable gets the type:

```css
@property --A {
  syntax: "<length>";
  inherits: false;
  initial-value: 120px;
}

.A {
  width: var(--A);
}
```

On a custom property set directly on the element, it registers that property, so you don't have to write the `@property` yourself:

```js
css`
  --brand: var(${color} type(<color>), #f00);
  color: var(--brand);
  transition: --brand 200ms;
`;
```

```css
@property --brand {
  syntax: "<color>";
  inherits: false;
  initial-value: red;
}
```

Typed values are larger, and each type and default gets its own variable, so they're opt-in. In return:

- A value of the wrong type uses the default, instead of resetting the property.
- The variable can be transitioned and animated, as in the example above.
- The default is checked against the type during the build.

A typed value must have a default, which can't use `${…}`, `var()`, or anything that depends on where it's used, such as `em`, `rem`, container units, `env()`, or `attr()`: browsers ignore the whole `@property` rule otherwise, so the build fails. Browsers without `@property` (before July 2024) have no default for a typed value until the runtime sets it.

#### Animations

`@keyframes`, `@position-try`, and `@function` read variables from the element using them, so they can hold values too:

```js
const bar = css`
  @keyframes grow {
    to {
      width: var(${width}px, 200px);
    }
  }

  animation: grow 1s forwards;
`;
```

The generated class has to be on the element that runs the animation, since variables don't inherit.

#### Using `cn`

Blocks with values work with `cn`, and the later value wins. A `cn` call with one runs in the browser, so it includes the lookup table:

```js
cn(
  css`width: ${small}px;`,
  css`width: ${large}px;`,
);
```

A block whose value is `null` or `undefined` adds no class, so it doesn't clear an earlier block's value of the same variable.

#### Where values can go

`${…}` becomes a `var()`, so it can only go where `var()` works: in a declaration's value. These fail the build:

```js
css`
  .${name} { color: red; }                 /* selectors */
  margin-${side}: 0;                       /* property names */
  @media (min-width: ${bp}px) { top: 0; }  /* at-rule conditions, see Sharing media queries */
  @font-face { font-weight: ${weight}; }   /* @font-face, @property, @page, and similar */
  content: "${label}";                     /* quoted strings */
  background-image: url(${path});          /* url() */
`;
```

For strings and URLs, pass the whole value:

```js
css`
  content: ${JSON.stringify(label)};
  --image: ${`url("${path}")`};
  background-image: var(--image);
`;
```

Values must be strings or numbers, or `null` or `undefined` to use the default. Anything else, including `false`, `NaN`, and objects, [throws an error](#runtime-errors) when the block runs, so write `${open ? width : null}` rather than `${open && width}`. To combine blocks, use `cn` rather than interpolating one into another.

#### Server rendering

The server renders the same class strings as the browser, so hydration matches, but it doesn't write the generated rules. The page uses the defaults until the runtime sets the values in the browser, so pick a default close to the usual value to avoid a visible jump. Without a default, the declaration has no effect until then.

Values need code that runs in the browser. `${…}` fails the build in HTML, and in the frontmatter and templates of Astro components, where it could never be set (Astro client scripts are fine). React Server Components have the same problem, but the build can't detect it there: use client components for blocks with values.

#### Browser support

Runtime values work in every [Baseline](https://developer.mozilla.org/en-US/docs/Glossary/Baseline/Compatibility) browser. They need [constructable stylesheets](https://caniuse.com/mdn-api_document_adoptedstylesheets) and [`@property`](https://caniuse.com/mdn-css_at-rules_property), so they fully work from:

| Chrome and Edge | Firefox | Safari and iOS Safari | Samsung Internet |
| --- | --- | --- | --- |
| 99 | 128 | 16.4 | 18 |

In older browsers:

- **Without `@property`** (Firefox 101 to 127), values work, but an element with no value of its own takes its parent's instead of its default, and a typed value has no default.
- **Without constructable stylesheets, or where they can't be added to** (Chrome before 99, Firefox before 101, Safari before 16.4), values aren't set, so the page keeps its defaults.

`@keyframes` works wherever these do. `@position-try` is newer: it needs Chrome 125, Firefox 147, or Safari 26. `@function` isn't Baseline: it needs Chrome 139, and isn't yet in Firefox or Safari, so a block using it there keeps the rest of its styles but not the function's.

#### When to use `style` instead

Every new value adds a rule that's never removed. That suits values with a limited set of results, such as a theme color or a chosen size. For values that change constantly, such as a drag position or anything set per frame, use the `style` attribute and read it from the block:

```jsx
const box = css`
  transform: translateX(var(--x));
`;

<div className={box} style={{ "--x": `${x}px` }} />;
```

### Selectors

Use `&` for the element, as in native CSS nesting. Anything that isn't the bare element (pseudo-classes, pseudo-elements, and complex selectors) becomes a selector variant:

```js
css`
  color: gray;

  &:hover { color: black; }
  &::before { content: '→'; }
  & > * + * { margin-top: 1rem; }
  .dark & { color: white; }
  a { text-decoration: underline; } /* the same as ` &
  a` */
`;
```

### At-rules

Declarations inside `@media`, `@supports`, `@container`, `@layer`, `@scope`, and `@starting-style` become atomic classes too, grouped under one copy of each at-rule in the output. They can be nested inside each other and inside selectors.

Other at-rules, such as `@keyframes`, `@font-face`, and `@property`, are copied to the output as they are. When several blocks define the same one, it's written once. For at-rules that replace each other, such as two `@keyframes` with the same name, only the last definition is kept.

```js
css`
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  animation: fade-in 200ms ease-out;
`;
```

#### Local keyframes

By default, keyframes names are global, so two blocks that each define a different `@keyframes spin` collide, and the last one wins everywhere. Set `"keyframeLocalization": true` in your `package.json`'s `pre.style` field to give each `@keyframes` a generated name, as styled-components' `keyframes` helper does:

- A block's or stylesheet file's `@keyframes` get a short generated name, and its `animation` and `animation-name` declarations use it. In a stylesheet file, every class in the file shares the file's keyframes, as in CSS Modules.
- Keyframes with the same contents get the same name wherever they're defined, so they're written once.
- Keyframes from [prepended files](#sharing-values-with-prepended-files) are localized too. Every block gets the same copy, so prepended files are the way to share keyframes between blocks.
- Names a block or file doesn't define are left as they are, so `animation-name: spin` still refers to a global `@keyframes spin`, for example one in a CSS file that pre.style doesn't process. That also means a block can't use keyframes another block defines.
- Names in custom properties (`--anim: spin`) aren't renamed, because pre.style can't tell they name keyframes.

#### Local custom properties

By default, custom properties are global, so two blocks that each set `--gap` on nested elements affect each other. Set `"customPropertyLocalization": true` in your `package.json`'s `pre.style` field to give each custom property a generated name:

```js
const card = css`
  --gap: 8px;
  padding: var(--gap);
`;
```

```css
.A {
  --B: 8px;
}

.C {
  padding: var(--B);
}
```

- A name a block or stylesheet file declares (with `--x: …` or `@property --x`) gets a generated name there, including in `var()`, `transition-property`, `will-change`, `@keyframes`, and `@container style()`. In a stylesheet file, every class in the file shares it.
- Names it only reads are left as they are, so `color: var(--token)` still refers to a global `--token`.
- Names from [prepended files](#sharing-values-with-prepended-files) are left as they are, even when a block sets them, so they're the way to share custom properties.
- Other names that start with `--`, such as `anchor-name` and `@custom-media`, aren't custom properties, and aren't renamed.
- [Runtime values](#custom-properties) follow: `--brand: ${color}` sets the generated name.

> [!WARNING]
> This changes what a block's CSS means, and failures are silent:
>
> - `style={{ "--gap": "16px" }}` no longer overrides a block's `--gap`, since the block's name has changed. Neither does `getPropertyValue("--gap")` find it.
> - A child block can't read a `--gap` its parent block sets. Put a value that's shared between blocks in a prepended file.

**It's for avoiding collisions, not for smaller output.** Blocks stop sharing classes for the same declaration, and in our tests that usually made the CSS larger: 50 blocks setting `--gap: 8px` grew by about 170%, gzipped. Long names used once are the exception: they shrink, by about 10% gzipped. Most projects don't need this.

### `composes` in blocks

A block can build on classes from a [stylesheet file](#stylesheet-files), or on global class names, with `composes`, as in CSS Modules:

```js
css`
  composes: button from "./button.css";
  composes: legacy-btn from global;
  color: white;
`;
```

The block's class string then includes the composed classes, and its own declarations replace the composed ones they conflict with, as `cn` would. `composes` must come before the block's other declarations, and can't be used inside nested selectors or at-rules.

### In HTML

HTML can't import anything, so blocks in HTML files that Vite processes, such as `index.html`, are found by matching `` css` `` and `` scss` ``:

```html
<main class="css`padding: 1rem; max-width: 60rem;`">…</main>
```

## Combining class strings with `cn`

Atomic classes all have the same specificity, so when two classes on one element set the same property, the order of the CSS file decides which wins, not the order in your `class` attribute. Use `cn` to combine class strings: when two classes conflict, it keeps the later one.

```js
import { css, cn } from "@pre.style/core";

const button = css`
  background-color: #0071ba;
  color: white;
`;
const danger = css`
  background-color: #c62828;
`;

const className = cn(button, isDanger && danger);
```

`cn` takes the same arguments as [clsx](https://github.com/lukeed/clsx): strings, arrays, objects whose keys are included when their value is truthy, and falsy values, which are ignored.

Two classes conflict when they set the same property under the same at-rules and selector. A later shorthand also removes earlier longhands it covers.

When every argument is a block or a string literal, the plugin resolves the call during the build, so it costs nothing at runtime. Arguments can also name a top-level `const` holding one of these, or holding another call that's resolved this way (`const base = css`…`;` then `cn(base, …)`). Other calls use a small lookup table the plugin generates for your project.

> **Note:** `cn` removes `!important` declarations too. A later class that sets the same property wins, even when the earlier one is `!important`.

## Stylesheet files

Styles can also live in `.css` and `.scss` files, imported with the `pre.style` import attribute. Each class in the file is exported with its class string, like [CSS Modules](https://github.com/css-modules/css-modules):

```css
/* button.css */
.button {
  background-color: #0071ba;
  color: white;

  &:hover {
    background-color: #005a94;
  }
}

.primary-button {
  composes: button;
  font-weight: 600;
}
```

```jsx
import {
  button,
  "primary-button" as primaryButton,
} from "./button.css" with { type: "pre.style" };

<button className={primaryButton}>Save</button>;
```

`.css` files are compiled like `css` blocks, and `.scss` files like `scss` blocks, into the same atomic classes and the same CSS file. Each export is a plain string constant, so bundlers drop the ones you don't use. A class that isn't a valid identifier (`primary-button`) is exported by its string name, so import it with `as`. Only imports with `with { type: 'pre.style' }` are compiled this way; plain `import './global.css'` and `.module.css` imports work as usual. Your `tsconfig.json` needs `"module"` set to `"esnext"`, `"preserve"`, or a `"node*"` setting for TypeScript to allow the attribute.

How a file becomes classes:

- **Each class is a block.** A class's rules, wherever they are in the file, are compiled as one block with the class replaced by `&`. `.button:hover` is `&:hover`, `@media (…) { .button { … } }` is an at-rule class of `button`, and a later rule for the class overrides an earlier one, as in plain CSS.
- **A selector belongs to the class it styles:** the first class in the rightmost part of the selector that has one. `.card .title` belongs to `title`, and `.list > li` to `list` (as `& > li`).
- **Selector lists** (`.a, .b { … }`) apply the declarations to each class.
- **Rules without a class,** such as `:root`, `body`, `@keyframes`, and `@font-face`, are written to the CSS file as they are. So are `@import` rules, as in blocks.
- **Empty classes** (`.empty {}`) are exported as `''`.
- **Everything is global.** There's no `:global()` or `:local()`. Classes that aren't exported from the file, such as `.dark` in `.dark .button`, are written as they are, so you add them to elements yourself.
- **Classes from prepended files aren't exported.** Their rules are written as they are.
- **Every class in an imported file is written to the CSS file,** even the ones you don't use, as with CSS Modules.

In `.scss` files, relative `@use`, `@forward`, and `@import` resolve from the file, and [prepended files](#sharing-values-with-prepended-files) work as they do in blocks. Classes a prepended mixin writes into the file are the file's own.

### Classes used as context

Atomic classes are shared, so no single class in a class string identifies one export. When an exported class is used as context for another, as `card` is in `.card:hover .title`, pre.style gives it a **marker**: one extra class, added to `card`'s class string, that the selector uses.

```css
.card {
  padding-top: 1rem;
}
.title {
  color: black;
}
.card:hover .title {
  color: red;
}
```

```css
.D {
  padding-top: 1rem;
}
.C {
  color: #000;
}
.A:hover .B {
  color: red;
}
```

`card` is `"D A"`, where `A` is its marker, and `title` is `"C B"`.

> [!IMPORTANT]
> **Watch out for compound selectors.** In `.a.b { … }`, the first class, `a`, gets the declarations, and `b` becomes a marker. `b`'s export is only its marker, so `b` on its own applies none of those styles: they apply to elements with both `a` and `b`. Prefer separate classes, or a selector variant on one class (`.a { &.is-open { … } }`), when you can.

### `composes` in stylesheet files

`composes` works as in CSS Modules:

```css
.base {
  color: gray;
  padding: 1rem;
}
.primary {
  composes: base;
  color: blue;
}
.wide {
  composes: card from "./card.css";
}
.legacy {
  composes: old-btn from global;
}
```

> [!IMPORTANT]
> **`composes` resolves conflicts, unlike CSS Modules.** CSS Modules only joins class names. pre.style resolves `composes` like `cn(composed, own)`: the class's own declarations replace the composed ones they conflict with, and those are dropped from the class string. Above, `primary` has `color: blue` and not `color: gray`. As in CSS Modules, `composes` must come before the rule's other declarations, can't be used in nested selectors or at-rules, and fails the build if classes compose each other in a cycle.

Classes composed `from global` are added to the class string as they are. Composed classes keep their markers.

### Using exports with `cn`

Stylesheet exports are plain class strings, so they work with `cn`. Calls whose arguments are all blocks, string literals, or stylesheet exports (named imports, or members of a namespace import such as `styles.button`) are resolved during the build.

### Types

TypeScript 7.1 adds [content mappers](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/), which `@pre.style/core` provides, so named imports are typed with each file's exact classes. Register it in `tsconfig.json`:

```json
{
  "contentMappers": [
    { "package": "@pre.style/core", "extensions": [".css", ".scss"] }
  ]
}
```

Content mappers run code from a package, so `tsc` needs the `--runExternalCode` flag, and editors need the workspace to be trusted. Mappers are chosen by file extension, so every `.css` and `.scss` file in the program gets pre.style's types, including ones imported without the attribute.

Before TypeScript 7.1, add this declaration to your project instead (for example as `src/stylesheets.d.ts`):

```ts
declare module "*.css" {
  const classes: { readonly [name: string]: string };
  export = classes;
}
declare module "*.scss" {
  const classes: { readonly [name: string]: string };
  export = classes;
}
```

TypeScript can't type named imports from it, so use a namespace import:

```ts
import * as styles from "./button.css" with { type: "pre.style" };

styles.button;
```

Namespace imports still let bundlers drop the classes you don't use. **Remove the declaration when you register the content mapper:** TypeScript prefers it over the mapper.

## Sharing values with prepended files

Use `prependFiles`, in the `pre.style` field of your `package.json`, to add files to the start of every block and stylesheet file, for custom properties, SCSS variables, mixins, and so on. Each file is read once per build.

```json
{
  "pre.style": {
    "prependFiles": {
      "css": ["src/styles/tokens.css"],
      "scss": ["src/styles/_variables.scss", "src/styles/_mixins.scss"]
    }
  }
}
```

An array applies the files to every block. An object applies `css` files only to `css` blocks and `.css` files, and `scss` files only to `scss` blocks and `.scss` files. Paths are relative to the `package.json`.

Rules the files output, such as `:root { --space: 4px }`, appear in the CSS file once. Keep prepended files to things that don't output CSS, or output it once (variables, mixins, custom properties). Large libraries slow the build down.

### Sharing media queries

Use Sass variables to share media queries. They need `scss` blocks, and they compile to ordinary `@media` rules:

```scss
// src/styles/_variables.scss, in prependFiles.scss
$md: 768px;
```

```js
scss`
  flex-direction: column;

  @media (min-width: $md) {
    flex-direction: row;
  }
`;
```

`@custom-media` isn't resolved by pre.style. It's copied to the output as written, and no browser supports it by default yet, so `@media (--md)` rules don't apply. To use it anyway, pass the output CSS through another tool that resolves it, such as another Lightning CSS run:

```js
import { Features, transform } from 'lightningcss';

const { code } = transform({
  filename: 'pre.style.css',
  code: Buffer.from(css),
  drafts: { customMedia: true },
  include: Features.CustomMediaQueries,
});
```

or PostCSS with [`postcss-custom-media`](https://github.com/csstools/postcss-plugins/tree/main/plugins/postcss-custom-media).

Either way, pre.style has already written the file by then, and it treats an alias as its own query:

- Aliases aren't sorted with `min-width` queries, so an alias for a wider breakpoint can come before a narrower query, which then wins. Check the order of the output.
- `cn` doesn't treat `(--md)` and the query it stands for as conflicting, so it keeps classes from both.

## Component libraries

A component library styled with pre.style ships its blocks uncompiled, and each app's pre.style plugin compiles them along with the app's own. The library's classes share names and the CSS file with the app's, so a `color: red` in the library and one in the app are the same class, and `cn` resolves conflicts between them.

### Using a library

Install it. The plugin finds dependencies with a `pre.style` field in their `package.json` (and the libraries those depend on) and compiles them. There's nothing to configure.

To compile a package that doesn't have the field, or to change how one is compiled, use the `libraries` setting in your `package.json`'s `pre.style` field. `true` uses the defaults, and `false` leaves a package out.

```json
{
  "pre.style": {
    "libraries": {
      "legacy-ui": { "include": "dist/**/*.js" },
      "some-ui": false
    }
  }
}
```

A library's class names depend on the whole app, so they differ between apps. Don't depend on them.

### Writing a library

- Ship ESM JavaScript (or TypeScript) with the blocks left as they are. Don't run pre.style on the library itself.
- List `@pre.style/core` as a peer dependency, so the library and the app share one copy.
- Add a `pre.style` field to `package.json`:

```json
{
  "name": "@acme/ui",
  "peerDependencies": {
    "@pre.style/core": "^3.0.0"
  },
  "pre.style": {
    "include": "dist/**/*.js",
    "prependFiles": {
      "css": ["dist/styles/tokens.css"],
      "scss": ["dist/styles/_tokens.scss"]
    }
  }
}
```

| Field                  | Default                      | Description                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`              | Every JS, TS, and Astro file | Globs of the files with blocks, relative to the package. A glob or an array of them. Stylesheet files the library imports are found from its imports.                                                                                             |
| `exclude`              |                              | Globs removed from `include`.                                                                                                                                                                                                                     |
| `prependFiles`         |                              | Files added to the start of the library's blocks and stylesheet files, relative to the package. They apply only to the library's, not the app's, so the library's tokens and mixins are always available to it and never leak into the app.       |
| `keyframeLocalization` | `false`                      | Give each `@keyframes` in the library's blocks and stylesheet files a generated name. See [Local keyframes](#local-keyframes). The library's setting applies to its blocks, whatever the app sets, since the library's styles are written for it. |
| `customPropertyLocalization` | `false`                      | Give each custom property declared in the library's blocks and stylesheet files a generated name, used only there. See [Local custom properties](#local-custom-properties). |

`"pre.style": true` uses the defaults. A library's field uses the same name and shape as an app's (see [Configuration](#configuration)). `libraries` and `quirksMode` only apply to the app, so in a library's field they're ignored, with a warning. A package that is both, such as a library with its own demo app, is read as the app when it's the Vite root, and as a library when it's a dependency.

To let apps use the library's tokens in their own blocks, export the token files, and apps can add them to their own `prependFiles`.

The plugin excludes libraries from Vite's dependency pre-bundling and from SSR externalization, so their blocks reach it in dev and on the server.

## How the CSS is written

### Class names

Each class is one declaration, under the at-rules and selector variant it was written in. Every class gets a name from one list, and the most-used classes get the shortest ones: one character for the first 53, then two characters for the next few thousand. Names don't say what a class is under; `cn` gets that from its lookup table.

Declarations that mean the same thing share a class: `color: blue` and `color: #00f` are the same class. So do equivalent nestings, such as `@media (…) { &:hover { … } }` and `&:hover { @media (…) { … } }`.

Production builds scan your files first, so names are stable between builds. In dev, names are assigned as files are served. **Dev class names can change between dev sessions and differ from production names, so don't depend on them.**

### Shorthands

Shorthand properties are expanded into their longhands, so `cn` can resolve conflicts between them:

```js
css`
  margin: auto;
`;
```

```css
.D {
  margin-top: auto;
}
.C {
  margin-right: auto;
}
.A {
  margin-bottom: auto;
}
.B {
  margin-left: auto;
}
```

`border` (which sets 12 longhands), shorthands whose values aren't known until runtime (values with `var()`, `env()`, or `attr()`), and shorthands set to a CSS-wide keyword (`font: inherit`, `margin: initial`) are kept as one class. They're written before longhands, so a longhand still wins:

```js
css`
  padding: var(--space);
  padding-top: 0;
`;
```

Expanding means some shorthands produce many classes. For example, `font` also resets the `font-variant-*` properties, among others, so it becomes about 20 classes. The CSS file barely grows, because the classes are shared across your project, but class strings get longer.

### Order

Within one block, a later declaration overrides an earlier one, as in plain CSS. Across blocks, the CSS file is ordered so the usual rules hold:

1. Hoisted at-rules (`@layer` statements, `@import`, `@namespace`), then other copied at-rules. With the `layer` option, everything but `@import` and `@namespace` is inside the layer.
2. Classes on the element.
3. Selector variants, with pseudo-classes in LVHFA order (`:link`, `:visited`, `:hover`, `:focus`, `:active`).
4. At-rule groups. `@media` queries with only a `min-width` come last, smallest first (mobile-first).

## Compared to utility-first frameworks

Utility-first frameworks such as [Tailwind CSS](https://tailwindcss.com/) also produce atomic CSS, so the same styles cost about the same in either. The differences are elsewhere:

- **CSS file.** Each declaration is written once in both, so the classes themselves come to about the same size. pre.style adds no reset or base styles, and no supporting rules beyond what your blocks contain. A framework's reset can be larger than all of a small app's classes.
- **Markup.** pre.style's class names are generated and one to three characters long, so class strings are much shorter than utility names like `px-5 py-4 rounded-xl`. Class strings end up in your JS and in every server-rendered page, so this saving grows with your markup. Some shorthands do produce many classes (see [Shorthands](#shorthands)).
- **Combining classes.** `cn` is resolved during the build when its arguments are known, and otherwise uses a small table generated for your project. Utility frameworks need a separate library that knows every utility to do the same.
- **In the browser.** No difference. Both are static CSS with single-class selectors and nothing running at runtime, so apart from download size the browser does the same work.
- **Build speed.** A utility framework only scans your files for class names. pre.style parses every block with Lightning CSS, and runs Sass for `scss` blocks. That takes more time during the build, but your users never see it.

## Configuration

Options live in one of two places. Each option is set in exactly one of them.

### In `package.json`

Options every tool that reads your styles has to agree on (the bundler plugin, and TypeScript's [content mapper](#types)) go in a `pre.style` field in your app's `package.json`. The plugin reads the `package.json` nearest Vite's root, and paths in it are relative to that file. All options are optional.

```json
{
  "pre.style": {
    "include": ["src/**/*.{ts,tsx}", "index.html"],
    "prependFiles": ["src/styles/tokens.css"]
  }
}
```

| Option                 | Default                                           | Description                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include`              | `**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,html,astro}` | Globs of the files with blocks, relative to the `package.json`. A glob or an array of them. Scanned before a build to assign names; stylesheet files are found from the scanned files' imports. `node_modules` and the output directory are always skipped.  |
| `exclude`              |                                                   | Globs removed from `include`.                                                                                                                                                                                                                                |
| `prependFiles`         |                                                   | Files added to the start of the app's blocks and stylesheet files. See [Sharing values with prepended files](#sharing-values-with-prepended-files).                                                                                                          |
| `libraries`            |                                                   | Component libraries to compile, by package name, in addition to dependencies with a `pre.style` field. A config replaces the package's field, `true` uses the defaults, and `false` leaves the package out. See [Component libraries](#component-libraries). |
| `quirksMode`           | `false`                                           | **You probably don't want this.** Use lowercase class names only, for pages in quirks mode. Names get longer. See [Quirks mode](#quirks-mode).                                                                                                               |
| `keyframeLocalization` | `false`                                           | Give each `@keyframes` in the app's blocks and stylesheet files a generated name, used only in the block or file that defines it. See [Local keyframes](#local-keyframes). Libraries use their own setting.                                                  |
| `customPropertyLocalization` | `false`                                           | Give each custom property declared in the app's blocks and stylesheet files a generated name, used only there. See [Local custom properties](#local-custom-properties). |

The plugin warns about keys it doesn't know, and fails the build on values of the wrong type. For completion and validation in your editor, `@pre.style/core` includes a JSON Schema for the field, at `node_modules/@pre.style/core/package.schema.json`. In VS Code, add it to your settings:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["package.json"],
      "schema": {
        "properties": {
          "pre.style": {
            "$ref": "./node_modules/@pre.style/core/package.schema.json"
          }
        }
      }
    }
  ]
}
```

### Plugin options

Options about how a build writes its output go to the plugin. All options are optional.

```ts
preStyle({
  lightningcss: { minify: true, targets: { safari: 16 << 16 } },
  sourceMap: true,
  layer: "pre.style",
  quotes: "single-quote",
  output: {
    file: "css/pre.style.css",
    banner: "/* Generated by pre.style */",
  },
});
```

| Option          | Default                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lightningcss`  |                                  | [Lightning CSS options](https://lightningcss.dev/transforms.html), such as `minify`, `targets`, `drafts`, and `visitor`. A `visitor` runs before pre.style processes each block. `filename`, `code`, `sourceMap`, `projectRoot`, `inputSourceMap`, and `cssModules` are ignored.                                                                                                                                                                                             |
| `sourceMap`     | `true` in dev, `false` in builds | Generate a source map for the CSS, mapping each class to the first block it appears in (a source map can only point to one place; the [DevTools extension](#tracing-classes-with-the-devtools-extension) lists them all). In dev, it's shown in the browser (the plugin turns on Vite's `css.devSourcemap`, unless you set it). In builds, it's written next to `output.file`. When you import `virtual:pre.style.css`, builds have no CSS source map, because Vite doesn't write them for bundled CSS.                                                                                                        |
| `layer`         | `false`                          | Wrap the CSS in a [cascade layer](https://developer.mozilla.org/docs/Web/CSS/@layer): `false` for none, `""` for an unnamed layer, or the layer's name, such as `"pre.style"` or `"vendor.pre-style"`. `@import` and `@namespace` rules stay before the layer, since they can't be inside one. `@layer` rules from blocks become layers nested in it. Browsers without cascade layers (Chrome before 99, Safari before 15.4, Firefox before 97) ignore everything inside it. |
| `quotes`        | `'double-quote'`                 | Quotes around the class string that replaces each block in JS: `'single-quote'`, `'double-quote'`, or `'backtick'`.                                                                                                                                                                                                                                                                                                                                                          |
| `output.file`   | `'pre.style.css'`                | Path and name of the CSS file, relative to Vite's `build.outDir`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `output.banner` |                                  | Text added to the start of the CSS file.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `output.footer` |                                  | Text added to the end of the CSS file.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The CSS isn't minified unless you set `lightningcss: { minify: true }`.

Before 3.1, `include`, `exclude`, `prependFiles`, `libraries`, and `quirksMode` were plugin options. Passing them to the plugin now fails with a message pointing to `package.json`.

### Tracing classes with the DevTools extension

Classes are shared, so one class can come from many blocks, and a source map can only point to one of them. The [pre.style DevTools extension](packages/devtools) adds a **pre.style** tab to the Elements panel in Chrome and Firefox. For the selected element, it lists each pre.style rule like the Styles pane does, with a link to every block that uses it.

It works with the Vite dev server while `sourceMap` is on, which is the default in dev. Setting `sourceMap: false` turns it off. It only runs on `localhost`, `*.localhost`, loopback addresses, and hostnames you add in its settings, and sends other sites no requests.

Its links open your editor through Vite, which guesses which one you use. When the dev server runs in VS Code's terminal, the plugin sets the `LAUNCH_EDITOR` environment variable to `code` if it isn't set, which also applies to Vite's error overlay. To choose an editor yourself, set `LAUNCH_EDITOR`.

### Quirks mode

> [!WARNING]
> **You probably don't want `quirksMode`.** It makes every project's output larger, and it only helps pages that can't have a doctype. If your pages start with `<!doctype html>`, as almost every modern page does, leave it off.

Pages without a doctype render in quirks mode, where class selectors ignore case. pre.style uses both uppercase and lowercase letters in class names, so `.A` and `.a` would apply to each other's elements. Add `<!doctype html>` to fix this. The plugin warns during the build when an HTML file it processes has no doctype.

If you can't add one, for example because your CSS is loaded into a page you don't control, set `"quirksMode": true` in your `package.json`'s `pre.style` field. Class names then use only lowercase letters, digits, `-`, and `_`. That leaves 27 one-character names instead of 53, and about 1,050 two-character names instead of 3,445, so names get longer once a project has more than about 27 classes.

## TypeScript

`css`, `scss`, and `cn` are typed. `css` and `scss` return `string`.

`css` and `scss` must be used as tagged templates (`` css`…` ``), and every block must be compiled by the plugin. If code that uses them runs without the plugin, for example in tests run directly in Node, they throw an error saying the transform wasn't applied, instead of silently rendering unstyled.

For stylesheet files, see [Types](#types).

## Errors

The build fails, with the file, line, and column, when:

- a block has invalid CSS syntax;
- Sass fails to compile an `scss` block;
- a block has `${…}` anywhere but a declaration's value, or in HTML or an Astro component's frontmatter or template (see [Where values can go](#where-values-can-go) and [Server rendering](#server-rendering));
- a `type()` has no default, or its default is invalid for the type or depends on where it's used;
- `css` or `scss` is used other than as a tagged template;
- a project has an `scss` block or file but Sass isn't installed;
- a stylesheet file has invalid CSS, or fails to compile with Sass;
- `composes` comes after other declarations, is used in a nested selector or at-rule, names a class or file that doesn't exist, or forms a cycle.

### Runtime errors

[Runtime values](#runtime-values) are checked in the browser and on the server. Outside production builds, errors have full messages. To keep the runtime small, production builds only have a number, the value's type, and a link to [a page that explains it](https://pre.style/errors):

| Error | Meaning |
| --- | --- |
| [`pre.style error 1 (<type>)`](https://pre.style/errors/1) | A `${…}` value wasn't a string or a finite number, or `null` or `undefined` to use the default. `number` means it was `NaN` or `Infinity`. For a condition, write `${open ? width : null}` rather than `${open && width}`. |

## Known limitations

- `@charset` is dropped. Lightning CSS always writes UTF-8.
- At-rules Lightning CSS doesn't parse, such as `@when`, `@function`, and `@custom-selector`, are copied to the output as they are.
- Nested pseudo-elements, such as `::before::marker`, aren't supported yet.
- Blocks in PHP and other templates aren't supported, because Vite doesn't output them.
- Component libraries are found among the app's dependencies and the dependencies of other libraries. A library used only through a package that isn't one (a wrapper without a `pre.style` field) isn't found automatically; add it with the `libraries` option.
- Before a build, Astro components are scanned like HTML, by matching `` css` `` and `` scss` ``. In a component that imports from `@pre.style/core`, text that only looks like a block, such as a code sample, is compiled too, and fails the build if it isn't valid CSS.
- Positions in `scss` blocks point to the start of the block, since Sass's output doesn't match the original lines. In `.scss` files, Sass errors have positions, but source maps don't.
- In `.scss` files, rules from modules loaded with `@use` are written as they are, like prepended files' rules, and their classes aren't exported: Sass writes them before the file's own rules.
- Stylesheet imports must be static strings (`import`, `export … from`, and `import('./file.css', { with: { type: 'pre.style' } })`), and can't have a query.
- TypeScript's content mapper handles every `.css` and `.scss` file in the program, since mappers are chosen by extension. A project that also imports Vite's `.module.css` files without the attribute gets pre.style's types for them.
- Pages need a doctype (`<!doctype html>`). Without one, browsers use quirks mode, where class selectors ignore case, so classes like `.A` and `.a` would apply to each other's elements. See [Quirks mode](#quirks-mode).

## Packages

| Package           | Description                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pre.style/core` | `css`, `scss`, and `cn`, the compiler at `@pre.style/core/compiler` for bundler plugins, TypeScript's content mapper for stylesheet files, and the JSON Schema for the `package.json` field. |
| `@pre.style/vite` | The Vite plugin.                                                                                                                                                                             |
| [pre.style DevTools](packages/devtools) | A side pane for the Elements panel in Chrome and Firefox that lists every block using each class. Not published to the extension stores yet. |

## Development

The repo is an npm workspace with both packages under `packages/`.

### Priorities

pre.style aims to be very fast, with the smallest and most performant output possible. When weighing a change, the priorities are, in order:

1. **Output:** the size of what ships (the CSS file, class strings, and the `cn` lookup table) and how quickly the browser renders it.
2. **Build time:** how long the compiler and plugin take, in production builds and in dev.

A change that makes the output smaller or faster to render is worth a slower build. A faster build isn't worth a larger or slower output.

```sh
npm install
npm test           # node --test, on the TypeScript source
npm run typecheck
npm run lint       # Oxlint
npm run format     # Oxfmt
npm run build
```

`demo/` has three apps for trying pre.style on the client and server: a React Router app in framework mode (`react/react-router`), a TanStack Start app (`react/tanstack-start`), and an Astro app with React islands (`astro`). They have the same pages, and share a small React component library (`react/ui`), which ships its source with the blocks still in it (and a component styled from a `.scss` stylesheet file) and its design tokens, for each app's pre.style plugin to compile. The demos use the packages' TypeScript source, so changes to them show up without a build.

```sh
npm run demo:react-router          # dev server
npm run demo:react-router:build    # production build
npm run demo:react-router:start    # serve the production build

npm run demo:tanstack-start        # likewise for TanStack Start
npm run demo:tanstack-start:build
npm run demo:tanstack-start:start

npm run demo:astro                 # likewise for Astro
npm run demo:astro:build
npm run demo:astro:start
```

## License

MIT
