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
    // Sass variables, then declarations, custom properties, mixins, nested
    // rules, and at-rules. pre.style requires `composes` before any other
    // declaration, so custom properties and `@include` (whose declarations
    // would come first) go after declarations.
    'order/order': [
      'dollar-variables',
      'declarations',
      'custom-properties',
      { type: 'at-rule', name: 'include' },
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
