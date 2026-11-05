import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  call,
  isAllowedHost,
  matchRules,
  readGenerated,
  readSelected,
  SELECTED,
  whenAllowed,
} from '../src/page.ts';
import { manifest } from '../src/manifest.ts';

interface Fake {
  localName: string;
  id: string;
  classList: string[];
  parentElement: Fake | null;
  previousElementSibling: Fake | null;
  matches?(selector: string): boolean;
}

const fake = (fields: Partial<Fake> = {}): Element =>
  ({
    localName: 'div',
    id: '',
    classList: [],
    parentElement: null,
    previousElementSibling: null,
    ...fields,
  }) as unknown as Element;

const withGlobals = (media: boolean, supports: boolean, run: () => void) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.matchMedia = () => ({ matches: media });
  globals.CSS = { supports: () => supports };
  try {
    run();
  } finally {
    delete globals.matchMedia;
    delete globals.CSS;
  }
};

describe('readSelected', () => {
  test('is null without an element', () => {
    assert.equal(readSelected(null), null);
    // A text node has no `classList`.
    assert.equal(readSelected({} as Element), null);
  });

  test('reads the element, its ancestors, and earlier siblings', () => {
    const uncle = fake({ classList: ['uncle'] }) as unknown as Fake;
    const parent = fake({
      classList: ['parent'],
      previousElementSibling: uncle,
    }) as unknown as Fake;
    const sibling = fake({ classList: ['sibling'] }) as unknown as Fake;
    const element = fake({
      id: 'x',
      classList: ['a', 'b'],
      parentElement: parent,
      previousElementSibling: sibling,
    });
    assert.deepEqual(readSelected(element), {
      label: 'div#x.a.b',
      own: ['a', 'b'],
      context: ['sibling', 'parent', 'uncle'],
    });
  });
});

describe('matchRules', () => {
  const seen: string[] = [];
  const element = fake({
    matches(selector: string) {
      seen.push(selector);
      if (selector === '.bad') throw new Error('invalid');
      return selector === '.a';
    },
  });

  test('checks selectors, with pseudo-elements removed', () => {
    withGlobals(true, true, () => {
      assert.deepEqual(
        matchRules(element, [
          { selector: '.a', atRules: [] },
          { selector: '.a::before', atRules: [] },
          { selector: '.b', atRules: [] },
          { selector: '.bad', atRules: [] },
        ]),
        [true, true, false, false],
      );
    });
  });

  test('checks media and supports conditions', () => {
    withGlobals(false, true, () => {
      assert.deepEqual(
        matchRules(element, [{ selector: '.a', atRules: ['@media (width >= 1px)'] }]),
        [false],
      );
    });
    withGlobals(true, false, () => {
      assert.deepEqual(
        matchRules(element, [{ selector: '.a', atRules: ['@supports (display: grid)'] }]),
        [false],
      );
    });
  });

  test('starting styles never apply, and other at-rules count as applying', () => {
    withGlobals(true, true, () => {
      assert.deepEqual(
        matchRules(element, [
          { selector: '.a', atRules: ['@starting-style'] },
          { selector: '.a', atRules: ['@container (width > 1px)', '@layer x'] },
        ]),
        [false, true],
      );
    });
  });
});

describe('call', () => {
  test('passes JSON, and $0 for the selected element', () => {
    const expression = call(matchRules, SELECTED, [{ selector: '"x"' }]);
    assert.ok(expression.endsWith(`($0,[{"selector":"\\"x\\""}])`));
  });

  test('page functions only use their own scope', () => {
    // Sent as text, so a helper from this module would be undefined there.
    const run = new Function(`return ${call(readSelected, null)}`);
    assert.equal(run(), null);
  });
});

describe('isAllowedHost', () => {
  test('accepts this computer', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0'])
      assert.equal(isAllowedHost(host), true, host);
  });

  test('accepts hostnames from the settings', () => {
    assert.equal(isAllowedHost('app.test', ['app.test']), true);
    assert.equal(isAllowedHost('192.168.1.5', ['192.168.1.5']), true);
    assert.equal(isAllowedHost('a.b.test', ['*.test']), true);
  });

  test('settings match whole names only', () => {
    assert.equal(isAllowedHost('other.test', ['app.test']), false);
    assert.equal(isAllowedHost('app.test.example.com', ['app.test']), false);
    assert.equal(isAllowedHost('notapp.test', ['app.test']), false);
    assert.equal(isAllowedHost('test', ['*.test']), false);
    assert.equal(isAllowedHost('nottest', ['*.test']), false);
  });

  test('rejects everything else, including lookalikes', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      'notlocalhost',
      '127.0.0.1.example.com',
      '127.0.0',
      '192.168.1.5',
      'app.test',
      '',
    ])
      assert.equal(isAllowedHost(host), false, host);
  });
});

const runWhenAllowed = (hostname: string, extra: string[] = []) => {
  const calls: string[] = [];
  const hit = () => calls.push('hit');
  const result = new Function('location', 'hit', `return ${whenAllowed('hit()', extra)}`)(
    { hostname },
    hit,
  );
  return { result, calls };
};

describe('whenAllowed', () => {
  test('runs the expression on a local page', () => {
    assert.deepEqual(runWhenAllowed('localhost'), { result: true, calls: ['hit'] });
  });

  test('runs it on a hostname from the settings', () => {
    assert.deepEqual(runWhenAllowed('app.test', ['app.test']), { result: true, calls: ['hit'] });
  });

  test('never runs it on another site', () => {
    assert.deepEqual(runWhenAllowed('example.com'), { result: false, calls: [] });
  });
});

describe('manifest', () => {
  test('only asks for storage', () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const result = manifest(browser, '1.0.0', 'd');
      assert.equal(result.devtools_page, 'devtools.html');
      assert.equal(result.options_ui.page, 'options.html');
      assert.deepEqual(result.permissions, ['storage']);
      assert.equal('host_permissions' in result, false);
    }
  });

  test('only Firefox gets an add-on ID', () => {
    assert.equal('browser_specific_settings' in manifest('chrome', '1.0.0', 'd'), false);
    assert.equal(
      manifest('firefox', '1.0.0', 'd').browser_specific_settings?.gecko.id,
      'devtools@pre.style',
    );
  });
});

const rule = (selectorText: string, property: string, value: string) => ({
  selectorText,
  style: Object.assign([property], { getPropertyValue: () => value }),
});
const withSheets = (cssRules: unknown[][], run: () => void) => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = { adoptedStyleSheets: cssRules.map((rules) => ({ cssRules: rules })) };
  try {
    run();
  } finally {
    delete globals.document;
  }
};

const of = (selector: string) => {
  let result: unknown;
  withSheets([[rule(selector, '--A', '1')]], () => {
    result = readGenerated(['_A1234'])[0].specificity;
  });
  return result;
};

describe('readGenerated', () => {
  test('reads the rules for the given classes', () => {
    withSheets([[rule('._A1234', '--A', ' 240px '), rule('._B1234::before', '--B', '"x"')]], () => {
      assert.deepEqual(readGenerated(['_A1234', '_B1234', 'C']), [
        {
          className: '_A1234',
          selector: '._A1234',
          property: '--A',
          value: '240px',
          specificity: [0, 1, 0],
          index: 0,
        },
        {
          className: '_B1234',
          selector: '._B1234::before',
          property: '--B',
          value: '"x"',
          specificity: [0, 1, 1],
          index: 1,
        },
      ]);
    });
  });

  test('leaves out other classes, and rules that set no custom property', () => {
    withSheets([[rule('._A1234', '--A', '1'), rule('._C', 'color', 'red')]], () => {
      assert.deepEqual(readGenerated(['_B1234', '_C']), []);
    });
  });

  test('specificity of selectors the runtime can write', () => {
    assert.deepEqual(of('._A1234 > *'), [0, 1, 0]);
    assert.deepEqual(of('._A1234 + li'), [0, 1, 1]);
    assert.deepEqual(of('._A1234:hover::after'), [0, 2, 1]);
    assert.deepEqual(of('.dark ._A1234 > a'), [0, 2, 1]);
  });

  test('a page with no adopted stylesheets', () => {
    withSheets([], () => assert.deepEqual(readGenerated(['_A1234']), []));
  });
});

describe('matchRules with pseudo-elements', () => {
  test('the older and newer forms are matched by their element', () => {
    const seen: string[] = [];
    const element = fake({
      matches(selector: string) {
        seen.push(selector);
        return true;
      },
    });
    const rules = ['.a:before', '.b::after', '.c:hover', '.d:first-line'].map((selector) => ({
      selector,
      atRules: [],
    }));
    assert.deepEqual(matchRules(element, rules), [true, true, true, true]);
    assert.deepEqual(seen, ['.a', '.b', '.c:hover', '.d']);
  });
});
