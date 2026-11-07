import { reactRouter } from '@react-router/dev/vite';
import {
  defineConfig,
  defaultClientConditions,
  defaultExternalConditions,
  defaultServerConditions,
} from 'vite';

// `pre.style-source` resolves pre.style's packages to their TypeScript
// source, so changes to them show up here without a build. Setting
// conditions replaces Vite's defaults, so they're added to them.
const SOURCE = 'pre.style-source';

// Vite bundles this config, including linked workspace packages, without
// that condition. Importing the plugin through a variable leaves it to Node,
// which the npm scripts run with `--conditions=pre.style-source`.
const plugin = '@pre.style/vite';
const { default: preStyle }: typeof import('@pre.style/vite') = await import(plugin);

export default defineConfig(({ command }) => ({
  plugins: [
    preStyle({
      // `include` and `prependFiles` are in the `pre.style` field of
      // package.json. The shared component library
      // (pre.style-demo-react-ui) is found through the same field in its
      // package.json, and compiled with its own tokens. The app's blocks
      // prepend the library's Sass mixins; its design tokens need no
      // prepending, since the library's own blocks write them to the CSS
      // file.
      lightningcss: { minify: true },
      // Source maps in dev only.
      sourceMap: command === 'serve',
    }),
    reactRouter(),
  ],
  resolve: { conditions: [SOURCE, ...defaultClientConditions] },
  ssr: {
    resolve: {
      conditions: [SOURCE, ...defaultServerConditions],
      externalConditions: [SOURCE, ...defaultExternalConditions],
    },
  },
}));
