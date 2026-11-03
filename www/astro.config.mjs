import { defineConfig, fontProviders } from "astro/config";
import preStyle from "@pre.style/vite";

// Unlike the demos, the site uses pre.style's published packages from npm,
// so it's built the way users build their own sites. It isn't an npm
// workspace, so the packages aren't linked to the repo's source.
export default defineConfig({
  site: "https://pre.style",
  output: "static",
  // Self-hosted as one variable font file, so every weight the site uses
  // comes from a single request.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "Geist",
      cssVariable: "--font-geist",
      weights: ["100 900"],
      styles: ["normal"],
    },
  ],
  vite: {
    plugins: [
      preStyle({
        lightningcss: { minify: true },
      }),
    ],
  },
});
