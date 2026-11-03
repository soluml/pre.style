import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeHost } from '../src/hosts.ts';

describe('normalizeHost', () => {
  test('keeps hostnames, lowercased and trimmed', () => {
    assert.equal(normalizeHost('  App.Test '), 'app.test');
    assert.equal(normalizeHost('192.168.1.5'), '192.168.1.5');
    assert.equal(normalizeHost('[fd00::1]'), '[fd00::1]');
  });

  test('reduces URLs and ports to the hostname', () => {
    assert.equal(normalizeHost('https://app.test:5173/some/page?a=1'), 'app.test');
    assert.equal(normalizeHost('app.test:5173'), 'app.test');
  });

  test('keeps a leading wildcard', () => {
    assert.equal(normalizeHost('*.Test'), '*.test');
  });

  test('rejects what is not a hostname', () => {
    for (const input of ['', '  ', 'a b', '*', '*.', 'a.*.test', '*.*.test', 'http://'])
      assert.equal(normalizeHost(input), null, input);
  });
});
