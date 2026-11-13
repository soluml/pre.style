// Lints the demos' blocks and stylesheet files with pre.style's Stylelint
// plugin, from its source (`npm run lint:css` sets the source condition).
import { fileURLToPath } from 'node:url';
import { preStyle } from '@pre.style/stylelint';

export default {
  // Built output.
  ignoreFiles: ['**/dist/**', '**/build/**', '**/.astro/**', '**/.output/**', '**/.tanstack/**'],
  extends: [
    'stylelint-config-standard-scss',
    // Last, so its syntax replaces the SCSS config's.
    preStyle({
      packages: [
        'demo/react/react-router',
        'demo/react/tanstack-start',
        'demo/react/ui',
        'demo/astro',
      ].map((dir) => fileURLToPath(new URL(dir, import.meta.url))),
    }),
  ],
};
