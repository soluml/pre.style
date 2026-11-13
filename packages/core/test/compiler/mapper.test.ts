import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPPER = fileURLToPath(new URL('../../src/compiler/mapper.ts', import.meta.url));

// Talks to the content mapper the way TypeScript does: JSON-RPC requests
// framed with a `Content-Length` header.
class Client {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (message: any) => void>();
  #buffer = Buffer.alloc(0);
  #id = 0;

  constructor() {
    this.#process = spawn(process.execPath, [MAPPER]);
    this.#process.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      for (;;) {
        const headerEnd = this.#buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const length = Number(
          /Content-Length: (\d+)/.exec(this.#buffer.toString('utf8', 0, headerEnd))![1],
        );
        if (this.#buffer.length < headerEnd + 4 + length) return;
        const message = JSON.parse(
          this.#buffer.toString('utf8', headerEnd + 4, headerEnd + 4 + length),
        );
        this.#buffer = this.#buffer.subarray(headerEnd + 4 + length);
        this.#pending.get(message.id)?.(message);
      }
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.#id;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    this.#process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#process.stdin.write(body);
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }

  close() {
    this.#process.kill();
  }
}

describe('content mapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pre-style-mapper-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'app', 'pre.style': { prependFiles: { scss: ['mixins.scss'] } } }),
  );
  // Starts with `@use`, which Sass rejects twice in one file.
  const mixins =
    "@use 'sass:math';\n@mixin utility($name) { .#{$name} { width: math.div(1px, 2); } }";
  writeFileSync(join(dir, 'mixins.scss'), mixins);
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  const client = new Client();
  before(async () => {
    await client.request('initialize', { positionEncodings: ['utf-8', 'utf-16'] });
  });
  after(() => client.close());

  test('initializes with UTF-16 positions', async () => {
    const { result } = await client.request('initialize', {
      positionEncodings: ['utf-8', 'utf-16'],
    });
    assert.deepEqual(result, { positionEncoding: 'utf-16', diagnosticSource: 'pre.style' });
  });

  test('opens a project from the package.json nearest its tsconfig.json, and watches it', async () => {
    const { result } = await client.request('openProject', {
      configFileName: join(dir, 'tsconfig.json'),
      projectHandle: 'p1',
      compilerOptions: {},
    });
    assert.match(result.configIdentity, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.watchedFiles, [join(dir, 'package.json'), join(dir, 'mixins.scss')]);
  });

  test('declares one string export per class, mapped to where the class is written', async () => {
    const content = '.button { color: red; }\n.primary-button { composes: button; }\n';
    const { result } = await client.request('transform', {
      fileName: join(dir, 'button.css'),
      content,
      projectHandle: 'p1',
    });
    assert.equal(
      result.text,
      'export declare const button: string;\n' +
        'declare const __pre_style_0: string;\n' +
        'export { __pre_style_0 as "primary-button" };\n',
    );
    assert.equal(result.extension, '.ts');
    const [first, second] = result.mappings;
    assert.equal(result.text.slice(first[0], first[0] + first[1]), 'button');
    assert.equal(content.slice(first[2], first[2] + first[3]), 'button');
    assert.equal(result.text.slice(second[0], second[0] + second[1]), 'primary-button');
    assert.equal(content.slice(second[2], second[2] + second[3]), 'primary-button');
  });

  test('scss files see the prepended files', async () => {
    const { result } = await client.request('transform', {
      fileName: join(dir, 'utilities.scss'),
      content: '@include utility(hidden);',
      projectHandle: 'p1',
    });
    assert.equal(result.text, 'export declare const hidden: string;\n');
  });

  test("a prepended file isn't prepended to itself", async () => {
    // TypeScript maps every .scss file in the program, prepended ones too.
    const { result } = await client.request('transform', {
      fileName: join(dir, 'mixins.scss'),
      content: mixins,
      projectHandle: 'p1',
    });
    assert.equal(result.diagnostics, undefined);
  });

  test('errors in a stylesheet file are diagnostics at their position', async () => {
    const content = '.a {\n  color: red;\n  & > { }}';
    const { result } = await client.request('transform', {
      fileName: join(dir, 'bad.css'),
      content,
      projectHandle: 'p1',
    });
    assert.equal(result.text, 'export {};\n');
    const [diagnostic] = result.diagnostics;
    assert.match(diagnostic.messageText, /^Invalid CSS/);
    assert.equal(content.slice(diagnostic.start), '{ }}');
  });

  test('unknown methods are JSON-RPC errors', async () => {
    const { error } = await client.request('nope', {});
    assert.equal(error.code, -32601);
  });
});
