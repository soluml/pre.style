import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prependPaths } from '../src/field.ts';

const pkg = (field: unknown) => JSON.stringify({ name: 'app', 'pre.style': field });

describe('prependPaths', () => {
  test('separate arrays for each language', () => {
    const text = pkg({ prependFiles: { css: ['a.css'], scss: ['_b.scss'] } });
    assert.deepEqual(prependPaths(text, 'css'), ['a.css']);
    assert.deepEqual(prependPaths(text, 'scss'), ['_b.scss']);
  });

  test('an array for both languages', () => {
    const text = pkg({ prependFiles: ['tokens.css'] });
    assert.deepEqual(prependPaths(text, 'css'), ['tokens.css']);
    assert.deepEqual(prependPaths(text, 'scss'), ['tokens.css']);
  });

  test('nothing without the field, prependFiles, or that language', () => {
    assert.deepEqual(prependPaths('{}', 'css'), []);
    assert.deepEqual(prependPaths(pkg(true), 'css'), []);
    assert.deepEqual(prependPaths(pkg({ prependFiles: { scss: ['_b.scss'] } }), 'css'), []);
  });

  test('invalid JSON and values are ignored', () => {
    assert.deepEqual(prependPaths('{ "pre.style": ', 'css'), []);
    assert.deepEqual(prependPaths(pkg({ prependFiles: { css: 'a.css' } }), 'css'), []);
    assert.deepEqual(prependPaths(pkg({ prependFiles: ['a.css', 1] }), 'css'), ['a.css']);
  });
});
