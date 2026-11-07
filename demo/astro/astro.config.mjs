import node from '@astrojs/node';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';
import preStyle from '@pre.style/vite';
import { defaultClientConditions, defaultExternalConditions, defaultServerConditions } from 'vite';

// `pre.style-source` resolves pre.style's packages to their TypeScript
// source, so changes to them show up here without a build. Setting
// conditions replaces Vite's defaults, so they're added to them. This config
// is .mjs because Astro imports those with Node, which the npm scripts run
// with `--conditions=pre.style-source`. It loads .ts configs with Vite, which
// would resolve the plugin to its build instead.
const SOURCE = 'pre.style-source';

// Astro renders pages on the server in two environments: `ssr` for pages
// rendered on demand, and `prerender` for those rendered during the build.
const serverResolve = {
  conditions: [SOURCE, ...defaultServerConditions],
  externalConditions: [SOURCE, ...defaultExternalConditions],
  // Astro's server code imports cookie@2, which npm nests in Astro's own
  // node_modules, since the React Router demo's Express hoists cookie@0.
  // Left external, the built server would find the hoisted one.
  noExternal: ['cookie'],
};

export default defineConfig({
  // Pages are prerendered unless they opt out, as the Server page does.
  output: 'static',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    react(),
    {
      // Added from an integration, which knows whether Astro is in dev.
      name: 'pre.style',
      hooks: {
        'astro:config:setup': ({ command, updateConfig }) => {
          updateConfig({
            vite: {
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
                  sourceMap: command === 'dev',
                }),
              ],
            },
          });
        },
      },
    },
  ],
  vite: {
    resolve: { conditions: [SOURCE, ...defaultClientConditions] },
    environments: {
      ssr: { resolve: serverResolve },
      prerender: { resolve: serverResolve },
    },
  },
});
