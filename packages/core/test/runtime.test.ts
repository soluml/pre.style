import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Server-side behavior is tested before a document exists, since the runtime
// keeps one stylesheet for the page.
const { dynamic, dynamicLowercase } = await import('../src/runtime.ts');
const dev = await import('../src/runtime-dev.ts');

const shape = /^_A[0-9A-Za-z]{4}$/;

describe('on the server', () => {
  test('adds a generated class to the class string', () => {
    const result = dynamic('A B', ['A', ['', 'px'], [240]]);
    const [a, b, generated, ...rest] = result.split(' ');
    assert.deepEqual([a, b, rest], ['A', 'B', []]);
    assert.match(generated, shape);
  });

  test('the same value gets the same class', () => {
    assert.equal(dynamic('A', ['A', ['', 'px'], [240]]), dynamic('A', ['A', ['', 'px'], [240]]));
  });

  test('the same text makes the same class, however it was written', () => {
    assert.equal(dynamic('', ['A', ['', 'px'], [240]]), dynamic('', ['A', ['', ''], ['240px']]));
  });

  test('different values get different classes', () => {
    assert.notEqual(dynamic('', ['A', ['', ''], [1]]), dynamic('', ['A', ['', ''], [2]]));
  });

  test('the same value on different variables gets different classes', () => {
    assert.notEqual(dynamic('', ['A', ['', ''], [1]]), dynamic('', ['B', ['', ''], [1]]));
  });

  test('a class string without atoms has no leading space', () => {
    assert.match(dynamic('', ['A', ['', ''], ['red'], '--brand']), shape);
  });

  test('joins several values into one', () => {
    assert.equal(
      dynamic('', ['A', ['', 'px ', 'px'], [1, 2]]),
      dynamic('', ['A', ['', ''], ['1px 2px']]),
    );
  });

  test('several variables each add a class', () => {
    assert.equal(dynamic('X', ['A', ['', ''], [1]], ['B', ['', ''], [2]]).split(' ').length, 3);
  });

  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
  ] as const) {
    test(`${name} adds no class, so the default applies`, () => {
      assert.equal(dynamic('A', ['A', ['', 'px'], [value]]), 'A');
    });
  }

  for (const [name, value, got] of [
    ['false', false, 'boolean'],
    ['true', true, 'boolean'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['an object', {}, 'object'],
    ['an array', [1], 'object'],
    ['a function', () => 1, 'function'],
    ['a symbol', Symbol('a'), 'symbol'],
    ['a bigint', 1n, 'bigint'],
  ] as const) {
    test(`${name} is an error`, () => {
      assert.throws(() => dynamic('A', ['A', ['', 'px'], [value]]), {
        name: 'TypeError',
        message: `pre.style error 1 (${typeof value}): https://pre.style/errors/1`,
      });
    });

    test(`${name} has a full message outside production`, () => {
      assert.throws(
        () => dev.dynamic('A', ['A', ['', 'px'], [value]]),
        (error: Error) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /must be strings or numbers/);
          assert.ok(error.message.includes(`Got ${got} in \`\${…}px\``));
          assert.match(error.message, /open \? width : null/);
          return true;
        },
      );
    });
  }

  test('an invalid value is an error even after a missing one', () => {
    assert.throws(() => dynamic('A', ['A', ['', ' ', ''], [null, false]]), TypeError);
  });

  test('one missing value means the variable has no value', () => {
    assert.equal(dynamic('A', ['A', ['', 'px ', 'px'], [1, null]]), 'A');
  });

  test('zero and empty strings are values', () => {
    assert.match(dynamic('', ['A', ['', ''], [0]]), shape);
    assert.match(dynamic('', ['A', ['', ''], ['']]), shape);
  });

  test('lowercase classes for quirks mode', () => {
    for (let i = 0; i < 50; i++) {
      assert.match(dynamicLowercase('', ['a', ['', ''], [`value-${i}`]]), /^_a[0-9a-z]{4}$/);
    }
  });

  test('development and production generate the same classes', () => {
    const variable = ['A', ['', 'px'], [240]] as const;
    assert.equal(dev.dynamic('X', [...variable]), dynamic('X', [...variable]));
    assert.equal(
      dev.dynamicLowercase('X', ['a', ['', ''], ['red']]),
      dynamicLowercase('X', ['a', ['', ''], ['red']]),
    );
  });

  test('hashes are stable, since the server and browser have to agree', () => {
    assert.equal(dynamic('', ['A', ['', 'px'], [240]]), dynamic('', ['A', ['', 'px'], ['240']]));
    assert.equal(dynamic('', ['A', ['', ''], ['240px']]), '_AFyfJ');
  });
});

describe('in the browser', () => {
  class FakeRule {
    selector: string;
    properties = new Map<string, string>();
    style = {
      setProperty: (property: string, value: string) => this.properties.set(property, value),
    };
    constructor(selector: string) {
      this.selector = selector;
    }
  }
  class FakeSheet {
    cssRules: FakeRule[] = [];
    insertRule(rule: string, index: number) {
      this.cssRules.splice(index, 0, new FakeRule(rule.slice(0, rule.indexOf('{'))));
      return index;
    }
  }
  const adopted: FakeSheet[] = [];
  const rules = () => adopted.flatMap((sheet) => sheet.cssRules);

  beforeEach(() => {
    Object.assign(globalThis, {
      CSSStyleSheet: FakeSheet,
      document: { adoptedStyleSheets: adopted },
    });
  });

  test('inserts a rule that sets the variable', () => {
    const result = dynamic('A', ['A', ['', 'px'], [321]]);
    const className = result.split(' ')[1];
    const rule = rules().find((r) => r.selector === `.${className}`)!;
    assert.deepEqual([...rule.properties], [['--A', '321px']]);
  });

  test('inserts a value only once', () => {
    const before = rules().length;
    dynamic('A', ['A', ['', 'px'], [654]]);
    dynamic('B', ['A', ['', 'px'], [654]]);
    assert.equal(rules().length, before + 1);
  });

  test('sets a named custom property', () => {
    const className = dynamic('', ['b', ['', ''], ['#00f'], '--brand']);
    const rule = rules().find((r) => r.selector === `.${className}`)!;
    assert.deepEqual([...rule.properties], [['--brand', '#00f']]);
  });

  test('a missing value inserts nothing', () => {
    const before = rules().length;
    dynamic('A', ['A', ['', ''], [null]]);
    assert.equal(rules().length, before);
  });

  test('uses one stylesheet', () => {
    assert.equal(adopted.length, 1);
  });

  test('returns the same class string as the server', () => {
    assert.equal(dynamic('A', ['A', ['', 'px'], [240]]).split(' ')[1], '_AFyfJ');
  });
});
