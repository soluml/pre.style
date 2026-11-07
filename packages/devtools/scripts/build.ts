import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { manifest } from '../src/manifest.ts';
import type { Browser } from '../src/manifest.ts';

const path = (relative: string) => new URL(`../${relative}`, import.meta.url).pathname;
const { version, description } = JSON.parse(await readFile(path('package.json'), 'utf8'));
const BROWSERS: Browser[] = ['chrome', 'firefox'];

await rm(path('dist'), { recursive: true, force: true });
for (const browser of BROWSERS) {
  const out = path(`dist/${browser}`);
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest(browser, version, description)));
  for (const file of ['devtools.html', 'pane.html', 'pane.css', 'options.html', 'options.css'])
    await copyFile(path(`static/${file}`), `${out}/${file}`);
  await copyFile(path('../vscode/images/icon.png'), `${out}/icon.png`);
  await build({
    entryPoints: ['devtools', 'pane', 'options', 'background'].map((name) =>
      path(`src/${name}.ts`),
    ),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: ['chrome120', 'firefox140'],
    // Page functions are sent to the page as text, so they stay readable for
    // store reviewers, and simple enough to keep working.
    minifySyntax: true,
    minifyWhitespace: true,
  });
}
