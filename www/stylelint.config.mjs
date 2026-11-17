// Lints the site's blocks, stylesheets, and Astro `<style>` tags.
//
// `stylelint-config-standard-scss` adds Sass support to the standard config,
// for `scss` blocks. pre.style's config comes last, so its syntax is the one
// used.
export default {
  extends: [
    'stylelint-config-standard',
    'stylelint-config-standard-scss',
    'stylelint-config-html/astro',
    'stylelint-prettier/recommended',
    '@pre.style/stylelint/config',
  ],
  plugins: ['stylelint-order', 'stylelint-no-unsupported-browser-features'],
  rules: {
    // Sass variables, then mixins, custom properties, declarations, nested
    // rules, and at-rules. Mixins come first so a block's own declarations
    // read as overrides of them. pre.style requires `composes` before any
    // other declaration (including ones a mixin or custom property adds), so
    // a block can't use both `composes` and an `@include` that declares
    // anything; the site doesn't use `composes`.
    'order/order': [
      'dollar-variables',
      { type: 'at-rule', name: 'include' },
      'custom-properties',
      'declarations',
      'rules',
      'at-rules',
    ],
    // Alphabetical, except `composes`, which must come first.
    'order/properties-order': [['composes'], { unspecified: 'bottomAlphabetical' }],
    // Kebab-case, plus `--` before a number for negative steps of a scale
    // (`--step--1`).
    'custom-property-pattern': [
      '^([a-z][a-z0-9]*)(-[a-z0-9]+|--[0-9]+)*$',
      { message: (name) => `Expected custom property name "${name}" to be kebab-case` },
    ],
    // The `browserslist` field's targets (Baseline).
    'plugin/no-unsupported-browser-features': [
      true,
      { severity: 'warning', ignorePartialSupport: true },
    ],
  },
};
