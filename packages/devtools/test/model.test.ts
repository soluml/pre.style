import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  attributeSource,
  buildView,
  classesToFetch,
  compareCascade,
  editorUrl,
  fileCount,
  withGenerated,
} from '../src/model.ts';
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

const source = (name: string, line = 1) => ({
  file: `/app/${name}`,
  path: name,
  line,
  column: 1,
});

const sourceOrder = (rules: Rule[], own: string[], matched = rules.map(() => true)) => {
  const view = buildView(rules, matched, own, '');
  return Object.fromEntries(
    [...view.applied, ...view.inactive].map(({ className, sources }) => [
      className,
      sources.map(({ path, line }) => `${path}:${line}`),
    ]),
  );
};

describe('source order', () => {
  test('files using more of the element’s classes come first', () => {
    const shared = source('a-shared.tsx');
    const button = source('z-button.tsx');
    const result = sourceOrder(
      [
        rule({ className: 'x', sources: [shared, button] }),
        rule({ className: 'y', property: 'margin-top', sources: [button] }),
      ],
      ['x', 'y'],
    );
    assert.deepEqual(result.x, ['z-button.tsx:1', 'a-shared.tsx:1']);
  });

  test('ties are alphabetical, then by position, whatever compiled first', () => {
    const result = sourceOrder(
      [
        rule({
          className: 'x',
          sources: [source('b.tsx'), source('a.tsx', 9), source('a.tsx', 2)],
        }),
      ],
      ['x'],
    );
    assert.deepEqual(result.x, ['a.tsx:2', 'a.tsx:9', 'b.tsx:1']);
  });

  test('several usages of a class in one file count once', () => {
    const result = sourceOrder(
      [
        rule({
          className: 'x',
          sources: [source('a.tsx', 1), source('a.tsx', 2), source('b.tsx')],
        }),
        rule({ className: 'y', property: 'margin-top', sources: [source('b.tsx')] }),
      ],
      ['x', 'y'],
    );
    assert.deepEqual(result.x, ['b.tsx:1', 'a.tsx:1', 'a.tsx:2']);
  });

  test('classes that do not apply right now count, and other elements’ classes do not', () => {
    const result = sourceOrder(
      [
        rule({ className: 'x', sources: [source('a.tsx'), source('b.tsx')] }),
        rule({
          className: 'hover',
          selector: '.hover:hover',
          property: 'margin-top',
          sources: [source('b.tsx')],
        }),
        rule({
          className: 'parent',
          selector: '.parent > *',
          property: 'margin-left',
          sources: [source('a.tsx')],
        }),
        rule({
          className: 'parent2',
          selector: '.parent2 > *',
          property: 'margin-right',
          sources: [source('a.tsx')],
        }),
      ],
      ['x', 'hover'],
      [true, false, true, true],
    );
    assert.deepEqual(result.x, ['b.tsx:1', 'a.tsx:1']);
  });

  test('a filter does not change the order', () => {
    const rules = [
      rule({ className: 'x', sources: [source('a.tsx'), source('b.tsx')] }),
      rule({ className: 'y', property: 'margin-top', sources: [source('b.tsx')] }),
    ];
    const view = buildView(rules, [true, true], ['x', 'y'], 'color');
    assert.deepEqual(
      view.applied[0].sources.map(({ path }) => path),
      ['b.tsx', 'a.tsx'],
    );
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

const generated = (fields: Partial<Parameters<typeof withGenerated>[1][number]> = {}) => ({
  className: '_A1234',
  selector: '._A1234',
  property: '--A',
  value: '240px',
  specificity: [0, 1, 0] as [number, number, number],
  index: 0,
  ...fields,
});

describe('pseudo-elements', () => {
  test('the older and newer forms share a group', () => {
    const view = buildView(
      [
        rule({ className: 'a', selector: '.a:before', property: 'content' }),
        rule({ className: 'b', selector: '.b::before', property: '--b' }),
        rule({ className: 'c', selector: '.c:after', property: 'content' }),
      ],
      [true, true, true],
      ['a', 'b', 'c'],
      '',
    );
    assert.deepEqual(
      view.pseudo.map(({ name, rules }) => [name, names(rules).toSorted()]),
      [
        ['::after', ['c']],
        ['::before', ['a', 'b']],
      ],
    );
    assert.deepEqual(view.applied, []);
  });

  test('a pseudo-class is not one', () => {
    const view = buildView([rule({ className: 'a', selector: '.a:hover' })], [true], ['a'], '');
    assert.deepEqual(names(view.applied), ['a']);
  });
});

describe('withGenerated', () => {
  const reader = rule({
    className: 'B',
    declaration: 'width: var(--A, 120px)',
    property: 'width',
    sources: [at('a.tsx', 3), at('b.tsx', 9)],
  });

  test('adds a rule, with the value as its declaration', () => {
    const [, added] = withGenerated([reader], [generated()]);
    assert.equal(added.className, '_A1234');
    assert.equal(added.declaration, '--A: 240px');
    assert.equal(added.property, '--A');
    assert.equal(added.generated, true);
  });

  test('takes its sources from the rules that read its variable', () => {
    const [, added] = withGenerated([reader], [generated()]);
    assert.deepEqual(added.sources, reader.sources);
  });

  test('a similar name is not a read', () => {
    const other = rule({ className: 'C', declaration: 'width: var(--AB)', sources: [at('c', 1)] });
    assert.deepEqual(withGenerated([other], [generated()])[1].sources, []);
  });

  test('a rule setting the same named property counts', () => {
    const named = rule({
      className: 'D',
      declaration: '--brand: red',
      property: '--brand',
      sources: [at('d', 1)],
    });
    const [, added] = withGenerated([named], [generated({ property: '--brand' })]);
    assert.deepEqual(added.sources, named.sources);
  });

  test('places are listed once', () => {
    const twin = { ...reader, className: 'E' };
    assert.equal(withGenerated([reader, twin], [generated()])[2].sources.length, 2);
  });

  test('comes after the CSS file, and later values win', () => {
    const rules = withGenerated(
      [rule({ className: 'F', property: '--A', declaration: '--A: 1px', order: 500 })],
      [generated({ index: 0 }), generated({ className: '_A5678', index: 1 })],
    );
    assert.deepEqual(names(rules.toSorted(compareCascade)), ['_A5678', '_A1234', 'F']);
  });

  test('the view groups them like other rules, and marks what they override', () => {
    const rules = withGenerated(
      [reader],
      [
        generated(),
        generated({ className: '_A5678', index: 1, value: '9px' }),
        generated({
          className: '_B1234',
          selector: '._B1234::before',
          property: '--B',
          value: '"x"',
          specificity: [0, 1, 1],
          index: 2,
        }),
      ],
    );
    const view = buildView(
      rules,
      [true, true, true, true],
      ['B', '_A1234', '_A5678', '_B1234'],
      '',
    );
    assert.deepEqual(names(view.applied), ['_A5678', '_A1234', 'B']);
    assert.equal(view.applied[1].overridden, true);
    assert.deepEqual(
      view.pseudo.map(({ name }) => name),
      ['::before'],
    );
    assert.deepEqual(names(view.pseudo[0].rules), ['_B1234']);
  });

  test('no generated rules changes nothing', () => {
    assert.deepEqual(withGenerated([reader], []), [reader]);
  });

  test('attributeSource reads a class attribute’s location', () => {
    assert.deepEqual(attributeSource('src/a:b.tsx:4:11', '/app/'), {
      file: '/app/src/a:b.tsx',
      path: 'src/a:b.tsx',
      line: 4,
      column: 11,
    });
    assert.equal(attributeSource('src/a.tsx:4:11', undefined), null);
    assert.equal(attributeSource('src/a.tsx', '/app'), null);
    assert.equal(attributeSource(null, '/app'), null);
  });
});
