import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildView, classesToFetch, compareCascade, editorUrl, fileCount } from '../src/model.ts';
import type { Rule } from '../src/model.ts';

const rule = (fields: Partial<Rule> & { className: string }): Rule => ({
  selector: `.${fields.className}`,
  atRules: [],
  declaration: 'color: red',
  property: 'color',
  covers: [],
  important: false,
  specificity: [0, 1, 0],
  order: 1,
  sources: [],
  ...fields,
});

const names = (rules: Rule[]) => rules.map(({ className }) => className);

const at = (file: string, line: number) => ({ file, path: file, line, column: 1 });

describe('compareCascade', () => {
  test('later wins between equals', () => {
    const list = [rule({ className: 'a', order: 1 }), rule({ className: 'b', order: 2 })];
    assert.deepEqual(names(list.toSorted(compareCascade)), ['b', 'a']);
  });

  test('specificity beats order', () => {
    const list = [
      rule({ className: 'b', order: 2 }),
      rule({ className: 'a', order: 1, specificity: [0, 2, 0] }),
    ];
    assert.deepEqual(names(list.toSorted(compareCascade)), ['a', 'b']);
  });

  test('!important beats specificity', () => {
    const list = [
      rule({ className: 'a', specificity: [1, 0, 0] }),
      rule({ className: 'b', important: true }),
    ];
    assert.deepEqual(names(list.toSorted(compareCascade)), ['b', 'a']);
  });

  test('unlayered beats layered, and the other way around for !important', () => {
    const layered = { atRules: ['@layer x'], specificity: [1, 0, 0] as [number, number, number] };
    assert.deepEqual(
      names(
        [rule({ className: 'a', ...layered }), rule({ className: 'b' })].toSorted(compareCascade),
      ),
      ['b', 'a'],
    );
    assert.deepEqual(
      names(
        [
          rule({ className: 'a', ...layered, important: true }),
          rule({ className: 'b', important: true }),
        ].toSorted(compareCascade),
      ),
      ['a', 'b'],
    );
  });
});

describe('buildView', () => {
  test('marks the losers of a property as overridden', () => {
    const view = buildView(
      [rule({ className: 'a', order: 1 }), rule({ className: 'b', order: 2 })],
      [true, true],
      ['a', 'b'],
      '',
    );
    assert.deepEqual(
      view.applied.map(({ className, overridden }) => [className, overridden]),
      [
        ['b', false],
        ['a', true],
      ],
    );
  });

  test('a later shorthand overrides a longhand, but not the other way around', () => {
    const shorthand = {
      className: 's',
      property: 'border',
      covers: ['border-top-color'],
    };
    const longhand = { className: 'l', property: 'border-top-color' };
    const later = buildView(
      [rule({ ...longhand, order: 1 }), rule({ ...shorthand, order: 2 })],
      [true, true],
      [],
      '',
    );
    assert.equal(later.applied.find((r) => r.className === 'l')!.overridden, true);
    const earlier = buildView(
      [rule({ ...shorthand, order: 1 }), rule({ ...longhand, order: 2 })],
      [true, true],
      [],
      '',
    );
    assert.equal(earlier.applied.find((r) => r.className === 's')!.overridden, false);
  });

  test('rules that do not match are inactive only for the element’s own classes', () => {
    const view = buildView(
      [
        rule({ className: 'own', selector: '.own:hover' }),
        rule({ className: 'parent', selector: '.parent > a' }),
        rule({ className: 'reaches', selector: '.reaches > *' }),
      ],
      [false, false, true],
      ['own'],
      '',
    );
    assert.deepEqual(names(view.inactive), ['own']);
    assert.deepEqual(names(view.applied), ['reaches']);
  });

  test('pseudo-elements are grouped and resolved on their own', () => {
    const view = buildView(
      [
        rule({ className: 'a' }),
        rule({ className: 'b', selector: '.b::before' }),
        rule({ className: 'c', selector: '.c::after' }),
      ],
      [true, true, true],
      [],
      '',
    );
    assert.equal(view.applied[0].overridden, false);
    assert.deepEqual(
      view.pseudo.map(({ name, rules }) => [name, rules[0].overridden]),
      [
        ['::after', false],
        ['::before', false],
      ],
    );
  });

  test('a filter hides rules but not what they override', () => {
    const view = buildView(
      [
        rule({ className: 'a', order: 1, declaration: 'color: red' }),
        rule({ className: 'b', order: 2, declaration: 'color: blue' }),
      ],
      [true, true],
      [],
      'RED',
    );
    assert.deepEqual(
      view.applied.map(({ className, overridden }) => [className, overridden]),
      [['a', true]],
    );
  });

  test('a filter also searches file paths', () => {
    const view = buildView(
      [
        rule({
          className: 'a',
          sources: [{ file: '/x/src/A.tsx', path: 'src/A.tsx', line: 1, column: 1 }],
        }),
        rule({ className: 'b', property: 'margin-top', declaration: 'margin-top: 0' }),
      ],
      [true, true],
      [],
      'a.tsx',
    );
    assert.deepEqual(names(view.applied), ['a']);
  });
});

describe('helpers', () => {
  test('classesToFetch dedupes, sorts, and drops names that need escaping', () => {
    assert.deepEqual(classesToFetch(['b', 'a'], ['a', 'c', 'w-[1px]']), ['a', 'b', 'c']);
  });

  test('fileCount counts files, not locations', () => {
    assert.equal(fileCount([at('/a', 1), at('/a', 9), at('/b', 1)]), 2);
  });

  test('editorUrl encodes the location for Vite’s route', () => {
    assert.equal(
      editorUrl('/app/__open-in-editor', { file: '/s p/A.tsx', path: '', line: 5, column: 18 }),
      '/app/__open-in-editor?file=%2Fs%20p%2FA.tsx%3A5%3A18',
    );
  });
});
