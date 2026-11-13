import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FindError, findInComponent, findInScript } from '../src/find.ts';

// Whether each `cn` call is resolved at build time, by the label in its
// last argument.
function resolved(code: string) {
  const source = `import { css, cn } from '@pre.style/core';
const red = css\`color: red;\`;
${code}`;
  const analysis = findInScript('test.ts', source)!;
  const calls = new Map<string, boolean>();
  for (const call of analysis.cnCalls) {
    const label = /'(case-[^']+)'\)$/.exec(source.slice(call.start, call.end))?.[1];
    if (label !== undefined) calls.set(label, call.args !== null);
  }
  return calls;
}

describe('cn arguments that name a const', () => {
  test('are resolved at build time', () => {
    const calls = resolved(`
cn(red, 'case-top');
const label = 'label' as const;
cn(label, 'case-string');
const both = cn(red, label);
cn(both, 'case-chained');
function f() { return cn(red, 'case-function'); }
`);
    assert.deepEqual(Object.fromEntries(calls), {
      'case-top': true,
      'case-string': true,
      'case-chained': true,
      'case-function': true,
    });
  });

  test("aren't resolved where another declaration of the name is visible", () => {
    const calls = resolved(`
function param(red: string) { return cn(red, 'case-param'); }
function destructured({ red = '' }) { return cn(red, 'case-destructured'); }
function rest(...red: string[]) { return cn(red, 'case-rest'); }
const arrow = (red: string) => cn(red, 'case-arrow');
function letInBlock(on: boolean) {
  if (on) {
    let red = 'x';
    return cn(red, 'case-let');
  }
}
function letLater() {
  {
    cn(red, 'case-let-later');
    let red = 'x';
  }
}
function hoistedVar() {
  cn(red, 'case-var-hoisted');
  var red = 'x';
}
function varInBlock() {
  {
    var red = 'x';
  }
  return cn(red, 'case-var-block');
}
try {} catch (red) { cn(red, 'case-catch'); }
for (const red of ['x']) cn(red, 'case-for-of');
for (let red = 0; red < 1; red++) cn(red, 'case-for');
function functionInBlock() {
  function red() {}
  return cn(red, 'case-function-declaration');
}
function classInBlock() {
  class red {}
  return cn(red, 'case-class');
}
(function red() { return cn(red, 'case-function-name'); });
(class red { m() { return cn(red, 'case-class-name'); } });
namespace N { const red = 'x'; cn(red, 'case-namespace'); }
function enumInFunction() {
  enum red { A }
  return cn(red, 'case-enum');
}
`);
    const cases = [
      'param',
      'destructured',
      'rest',
      'arrow',
      'let',
      'let-later',
      'var-hoisted',
      'var-block',
      'catch',
      'for-of',
      'for',
      'function-declaration',
      'class',
      'function-name',
      'class-name',
      'namespace',
      'enum',
    ];
    assert.deepEqual(
      Object.fromEntries(calls),
      Object.fromEntries(cases.map((name) => [`case-${name}`, false])),
    );
  });

  test("are resolved where other declarations of the name aren't visible", () => {
    const calls = resolved(`
function sibling(red: string) { return red; }
function other() { return cn(red, 'case-sibling-function'); }
function blocks() {
  { let red = 'x'; }
  return cn(red, 'case-sibling-block');
}
function nested() {
  const g = (red: string) => red;
  function h() { var red = 'x'; }
  return cn(red, 'case-nested-function');
}
const object = { red: 1 };
cn(red, 'case-property');
type red = string;
cn(red, 'case-type');
`);
    assert.deepEqual(Object.fromEntries(calls), {
      'case-sibling-function': true,
      'case-sibling-block': true,
      'case-nested-function': true,
      'case-property': true,
      'case-type': true,
    });
  });

  test("aren't resolved before the declaration outside a function", () => {
    const calls = resolved(`
cn(early, 'case-early');
const later = () => cn(early, 'case-early-in-function');
const early = css\`color: blue;\`;
`);
    assert.deepEqual(Object.fromEntries(calls), {
      'case-early': false,
      'case-early-in-function': true,
    });
  });
});

const find = (code: string) =>
  findInScript('test.ts', `import { css, cn } from '@pre.style/core';\n${code}`)!;

describe('blocks with runtime values', () => {
  test('keep the text and expressions', () => {
    const [found] = find('const a = css`width: ${w + 1}px; color: ${c};`;').blocks;
    assert.deepEqual(found.interpolation!.strings, ['width: ', 'px; color: ', ';']);
    assert.deepEqual(
      found.interpolation!.expressions.map((e) => e.code),
      ['w + 1', 'c'],
    );
    assert.equal(found.code, 'width: ${w + 1}px; color: ${c};');
  });

  test("aren't resolved in `cn` at build time", () => {
    const { cnCalls } = find('cn(css`width: ${w}px;`, css`color: red;`);');
    assert.equal(cnCalls[0].args, null);
    const named = find('const a = css`width: ${w}px;`;\ncn(a);');
    assert.equal(named.cnCalls[0].args, null);
  });

  test('blocks without values have no interpolation', () => {
    assert.equal(find('css`color: red;`').blocks[0].interpolation, undefined);
  });
});

describe('blocks in Astro components', () => {
  test('without `${…}`', () => {
    const [found] = findInComponent('<a class={css`color: red;`}></a>');
    assert.equal(found.code, 'color: red;');
    assert.equal(found.interpolation, undefined);
  });

  test('keep the text and expressions, with their positions', () => {
    const source = '<script>\n  const a = css`width: ${w + 1}px; color: ${c};`;\n</script>';
    const [found] = findInComponent(source);
    assert.deepEqual(found.interpolation!.strings, ['width: ', 'px; color: ', ';']);
    assert.deepEqual(
      found.interpolation!.expressions.map((e) => e.code),
      ['w + 1', 'c'],
    );
    assert.deepEqual([found.line, found.column], [2, 17]);
    assert.equal(source.slice(found.start, found.end), 'css`width: ${w + 1}px; color: ${c};`');
  });

  test('nested templates, braces, strings, and comments', () => {
    for (const expression of ['`${a}px`', 'f(`a`)', '{ a: 1 }.a', "'}`'", 'a /* } */']) {
      const blocks = findInComponent(`css\`width: \${${expression}}; color: red;\`; scss\`b: c;\``);
      assert.equal(blocks.length, 2, expression);
      assert.equal(blocks[0].interpolation!.expressions[0].code, expression);
      assert.equal(blocks[1].lang, 'scss');
    }
  });

  test('an unclosed block is skipped', () => {
    assert.deepEqual(findInComponent('css`width: ${a'), []);
    assert.deepEqual(findInComponent('css`color: red;'), []);
  });

  test('match what the compiled module finds', () => {
    const compiled = findInScript(
      'test.ts',
      "import { css } from '@pre.style/core';\ncss`width: ${w}px;`;",
    )!.blocks[0];
    assert.equal(findInComponent('css`width: ${w}px;`')[0].code, compiled.code);
  });
});

describe('class attributes in JSX', () => {
  test('are found on elements and components, with where they start', () => {
    const source = `import { css } from '@pre.style/core';
const a = <div className={css\`color: red;\`} id="x" />;
const b = <Card className="c" />;
const c = <ui.Badge class={x} />;
const d = <svg:circle className="e" />;
const e = <span data-x className />;
const f = <p {...props} />;
`;
    const { classAttributes } = findInScript('test.tsx', source)!;
    assert.deepEqual(
      classAttributes.map(({ insert, syntax, ...rest }) => ({
        ...rest,
        syntax,
        before: source.slice(insert - 1, insert + 1),
      })),
      [
        { line: 2, column: 16, component: false, syntax: 'jsx', before: '} ' },
        { line: 3, column: 17, component: true, syntax: 'jsx', before: '" ' },
        { line: 4, column: 21, component: true, syntax: 'jsx', before: '} ' },
        { line: 5, column: 23, component: false, syntax: 'jsx', before: '" ' },
        { line: 6, column: 24, component: false, syntax: 'jsx', before: 'e ' },
      ],
    );
  });

  test('are found in compiled Astro components', () => {
    // As Astro's compiler writes them.
    const source = `import { css } from '@pre.style/core';
const $$Page = $$createComponent(($$result) => {
  return $$render\`<h1\${$$addAttribute(title, "class")}>Hi</h1>
<p\${$$addAttribute(["a", b], "class:list")} data-x>
<a\${$$addAttribute(href, "href")}>\${$$renderComponent($$result, "Button", Button, { "tone": "x", "className": arrow })}
\${$$renderComponent($$result, "Card", Card, { "class": "c" }, { "default": () => $$render\`x\` })}\`;
});
`;
    const { classAttributes } = findInScript('Page.astro.ts', source)!;
    assert.deepEqual(
      classAttributes.map(({ insert, ...rest }) => ({
        ...rest,
        after: source.slice(insert, insert + 2),
      })),
      [
        { line: 3, column: 24, component: false, syntax: 'template', after: '>H' },
        { line: 4, column: 5, component: false, syntax: 'template', after: ' d' },
        { line: 5, column: 98, component: true, syntax: 'props', after: '"c' },
        { line: 6, column: 47, component: true, syntax: 'props', after: '"c' },
      ],
    );
  });
});

describe('misused blocks', () => {
  const code = `import { css } from '@pre.style/core';
const tag = css;
const a = css\`color: \${css\`color: red;\`};\`;
const b = css\`color: blue;\`;
`;

  test('throw by default', () => {
    assert.throws(() => findInScript('test.ts', code), FindError);
  });

  test('are collected, and the rest of the file is read, when errors are given', () => {
    const errors: FindError[] = [];
    const analysis = findInScript('test.ts', code, errors)!;
    assert.deepEqual(
      errors.map(({ line, column }) => [line, column]),
      [
        [2, 13],
        [3, 28],
      ],
    );
    assert.equal(analysis.blocks.length, 3);
  });
});
