import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';

// Runs the built demos and pre.style's generated CSS in real browser engines.
// Build the packages and demos first. Playwright's WebKit is close to Safari,
// but isn't Safari.

const engines = { chromium, firefox, webkit };

const root = new URL('../..', import.meta.url).pathname;

// Run in each demo's workspace, so arguments after `--` reach its `start` script.
const apps = [
  { dir: 'demo/react/react-router', name: 'react-router', port: 4401, args: [], counters: 1 },
  {
    dir: 'demo/react/tanstack-start',
    name: 'tanstack-start',
    port: 4402,
    args: ['--', '--port', '4402', '--host', '127.0.0.1', '--strictPort'],
    counters: 1,
  },
  { dir: 'demo/astro', name: 'astro', port: 4403, args: [], counters: 2 },
];

async function waitFor(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} didn't start`);
}

// The content each counter's `::before` shows.
const counts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('main p')]
      .map((p) => getComputedStyle(p, '::before').content)
      .filter((content) => content !== 'none' && content !== 'normal'),
  );

describe('demos', () => {
  const servers: ChildProcess[] = [];

  before(async () => {
    for (const { dir, port, args } of apps) {
      const server = spawn('npm', ['run', 'start', '-w', dir, ...args], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      });
      servers.push(server);
      await waitFor(`http://127.0.0.1:${port}/interpolation`);
    }
  });

  after(() => {
    // Each server is its own process group, so only these are stopped.
    for (const server of servers) process.kill(-server.pid!);
  });

  for (const [engine, type] of Object.entries(engines)) {
    describe(engine, () => {
      let browser: Browser;
      before(async () => {
        browser = await type.launch();
      });
      after(() => browser.close());

      for (const { name, port, counters } of apps) {
        test(`${name}: the counter hydrates and counts up`, async () => {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
          });
          await page.goto(`http://127.0.0.1:${port}/interpolation`);
          await page.waitForFunction(
            (expected) => {
              const shown = [...document.querySelectorAll('main p')]
                .map((p) => getComputedStyle(p, '::before').content)
                .filter((content) => /^"\d+"$/.test(content));
              return shown.length === expected && shown.every((c) => Number(c.slice(1, -1)) >= 2);
            },
            counters,
            { timeout: 15_000 },
          );
          const shown = await counts(page);
          assert.equal(shown.length, counters);
          const sheets = await page.evaluate(() => document.adoptedStyleSheets.length);
          assert.equal(sheets, 1);
          assert.deepEqual(errors, []);
          await page.close();
        });
      }
    });
  }
});

// What the compiler writes and the runtime inserts, without a framework.
const GENERATED = `
  @property --a { syntax: "*"; inherits: false; }
  @property --t { syntax: "<length>"; inherits: false; initial-value: 150px; }
  @property --c { syntax: "<color>"; inherits: false; initial-value: red; }
  @keyframes grow { from { width: var(--a, 10px); } to { width: var(--a, 10px); } }
  body { width: 1000px; }
  .w { width: var(--a, 120px); height: 1px; }
  .typed { width: var(--t); height: 1px; }
  .anim { animation: grow 1000s paused; height: 1px; }
  .before::before { content: var(--a, "default"); }
  .kids > * { width: var(--a, 10px); height: 1px; }
  .next + * { width: var(--a, 10px); height: 1px; }
  .fade { --c: red; transition: --c 1000s linear; color: var(--c); }
  .fade.on { --c: blue; }
`;

describe('generated CSS', () => {
  for (const [engine, type] of Object.entries(engines)) {
    test(engine, async () => {
      const browser = await type.launch();
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><style>${GENERATED}</style><body></body>`);
      const results = await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        document.adoptedStyleSheets.push(sheet);
        const set = (selector: string, property: string, value: string) => {
          const index = sheet.insertRule(`${selector}{}`, sheet.cssRules.length);
          (sheet.cssRules[index] as CSSStyleRule).style.setProperty(property, value);
        };
        const add = (className: string, parent: Element = document.body) => {
          const element = document.createElement('div');
          element.className = className;
          parent.append(element);
          return element;
        };
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Runs in the browser.
        const width = (element: Element) => getComputedStyle(element).width;

        set('.set300', '--a', '300px');
        set('.set77', '--a', '77px');
        set('.badtyped', '--t', 'red');
        set('.bad', '--a', 'red } body { display: none');
        set('.string::before', '--a', '"5"');
        set('.kid77 > *', '--a', '77px');
        set('.next77 + *', '--a', '77px');
        set('.typed99', '--t', '99px');

        const parent = add('w set300');
        add('next next77');
        const sibling = add('');
        const fade = add('fade');
        // Reading the style between the changes starts a transition.
        void getComputedStyle(fade).color;
        fade.classList.add('on');
        void getComputedStyle(fade).color;

        return {
          value: width(parent),
          nested: width(add('w', parent)),
          defaultValue: width(add('w')),
          typed: width(add('typed typed99')),
          typedDefault: width(add('typed')),
          typedWrong: width(add('typed badtyped')),
          keyframes: width(add('anim set77')),
          keyframesDefault: width(add('anim')),
          before: getComputedStyle(add('before string'), '::before').content,
          beforeDefault: getComputedStyle(add('before'), '::before').content,
          child: width(add('', add('kids kid77'))),
          sibling: width(sibling),
          injection: getComputedStyle(document.body).display,
          injectionRules: sheet.cssRules.length,
          transitions: fade.getAnimations().length,
        };
      });
      assert.deepEqual(results, {
        value: '300px',
        nested: '120px',
        defaultValue: '120px',
        typed: '99px',
        typedDefault: '150px',
        typedWrong: '150px',
        keyframes: '77px',
        keyframesDefault: '10px',
        before: '"5"',
        beforeDefault: '"default"',
        child: '77px',
        sibling: '77px',
        injection: 'block',
        injectionRules: 8,
        transitions: 1,
      });
      await browser.close();
    });
  }
});
