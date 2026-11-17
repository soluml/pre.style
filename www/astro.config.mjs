import { defineConfig, fontProviders } from 'astro/config';
import preStyle from '@pre.style/vite';
import autoImport from 'unplugin-auto-import/vite';
import iconsResolver from 'unplugin-icons/resolver';
import Icons from 'unplugin-icons/vite';

// Unlike the demos, the site uses pre.style's published packages from npm,
// so it's built the way users build their own sites. It isn't an npm
// workspace, so the packages aren't linked to the repo's source.
export default defineConfig({
  site: 'https://pre.style',
  output: 'static',
  // Self-hosted as one variable font file, so every weight the site uses
  // comes from a single request.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'DM Sans',
      cssVariable: '--font-dm',
      weights: ['100 1000'],
      styles: ['normal', 'italic'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Outfit',
      cssVariable: '--font-outfit',
      weights: ['100 900'],
      styles: ['normal'],
    },
    {
      // Static-only on Fontsource, so each weight is its own file. Code is
      // only set at 400.
      provider: fontProviders.fontsource(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-plex-mono',
      weights: [400],
      styles: ['normal'],
      fallbacks: ['monospace'],
    },
  ],
  vite: {
    plugins: [
      preStyle({
        lightningcss: { minify: true },
      }),
      autoImport({
        resolvers: [
          iconsResolver({
            prefix: 'Icon',
            extension: 'jsx',
          }),
        ],
      }),
      Icons({ autoInstall: true, scale: 0, compiler: 'astro' }),
    ],
  },
});
