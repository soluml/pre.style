// The TypeScript content mapper (TypeScript 7.1 and later). `tsc` and the
// editor run it as a separate process, through the `typescript.contentMapper`
// field in package.json, and send it each `.css` and `.scss` file in the
// program over JSON-RPC on stdio. It answers with a TypeScript view of the
// file that declares one `string` export per class, so named imports from
// stylesheet files are typed with their exact keys.
//
// Register it in tsconfig.json, and run `tsc --runExternalCode`:
//
//   "contentMappers": [{ "package": "@pre.style/core", "extensions": [".css", ".scss"] }]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PreStyleError } from './block.ts';
import { createCompiler } from './compiler.ts';
import type { Compiler } from './compiler.ts';
import { readConfig } from './config.ts';
import { configFiles, findLibraries } from './libraries.ts';
import { isIdentifier } from './stylesheet.ts';

interface Request {
  id?: string | number;
  method: string;
  params?: any;
}

// Each open project's compiler, by its handle.
const projects = new Map<string, Promise<Compiler>>();

// Diagnostic codes, for errors in a stylesheet file.
const INVALID_STYLESHEET = 9001;

async function openProject(params: {
  configFileName: string;
  projectHandle: string;
}): Promise<{ configIdentity: string; watchedFiles: string[] }> {
  // The project's package.json, nearest its tsconfig.json.
  const root = params.configFileName ? dirname(params.configFileName) : process.cwd();
  const app = readConfig(root);
  const libraries = findLibraries(app.dir, app.config.libraries);
  const compiler = createCompiler({
    root: app.dir,
    prependFiles: app.config.prependFiles,
    libraries: libraries.map(
      ({ dir, prependFiles, keyframeLocalization, customPropertyLocalization }) => ({
        dir,
        prependFiles,
        keyframeLocalization,
        customPropertyLocalization,
      }),
    ),
    quirksMode: app.config.quirksMode,
    keyframeLocalization: app.config.keyframeLocalization,
    customPropertyLocalization: app.config.customPropertyLocalization,
    warn: () => {},
  });
  projects.set(params.projectHandle, compiler);

  // Changes to these files change which classes files export.
  const watchedFiles = [
    ...configFiles(app.dir, libraries),
    ...(await compiler).prependFiles(),
  ].filter((file) => existsSync(file));
  const hash = createHash('sha256');
  for (const file of watchedFiles) hash.update(`${file}\0${readFileSync(file, 'utf8')}\0`);
  return { configIdentity: hash.digest('hex'), watchedFiles };
}

// The offset of a line and column (line from 0, column from 1) in `text`.
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
  }
  return Math.min(text.length, offset + column - 1);
}

async function transform(params: { fileName: string; content: string; projectHandle: string }) {
  const compiler = await projects.get(params.projectHandle);
  if (compiler === undefined) throw new Error(`Unknown project ${params.projectHandle}.`);
  const { fileName, content } = params;
  let names: string[];
  try {
    names = compiler.classNames({
      code: content,
      lang: fileName.endsWith('.scss') ? 'scss' : 'css',
      file: fileName,
    });
  } catch (error) {
    if (!(error instanceof PreStyleError)) throw error;
    const position = error.position;
    return {
      text: 'export {};\n',
      extension: '.ts',
      diagnostics: [
        {
          // The message without the file:line:col prefix, which the
          // diagnostic shows itself.
          messageText: error.message.replace(/^.*?:\d+:\d+: /, ''),
          start: position ? offsetOf(content, position.line, position.column) : 0,
          length: 0,
          code: INVALID_STYLESHEET,
        },
      ],
    };
  }

  // One `string` export per class. Each name maps to where the class is
  // first written in the file, so go-to-definition opens the stylesheet.
  let text = '';
  const mappings: number[][] = [];
  let local = 0;
  for (const name of names) {
    const written = new RegExp(`\\.${name.replace(/[^\w-]/g, '\\$&')}(?![\\w-])`).exec(content);
    let start: number;
    if (isIdentifier(name)) {
      text += 'export declare const ';
      start = text.length;
      text += `${name}: string;\n`;
    } else {
      const binding = `__pre_style_${local++}`;
      text += `declare const ${binding}: string;\nexport { ${binding} as `;
      start = text.length + 1;
      text += `${JSON.stringify(name)} };\n`;
    }
    // Verbatim mapping: the same text in both, in UTF-16 code units.
    if (written !== null) mappings.push([start, name.length, written.index + 1, name.length, 0]);
  }
  return { text: text || 'export {};\n', extension: '.ts', mappings };
}

async function handle(request: Request): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return { positionEncoding: 'utf-16', diagnosticSource: 'pre.style' };
    case 'openProject':
      return openProject(request.params);
    case 'transform':
      return transform(request.params);
    case 'closeProject':
      projects.delete(request.params.projectHandle);
      return null;
    default:
      throw Object.assign(new Error(`Unknown method ${request.method}.`), { code: -32601 });
  }
}

function send(message: unknown) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

// Messages are framed like the Language Server Protocol's: a
// `Content-Length` header, a blank line, then the JSON body.
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = Number(
      /Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1],
    );
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const request = JSON.parse(buffer.subarray(start, start + length).toString()) as Request;
    buffer = buffer.subarray(start + length);
    // Notifications have no ID, and get no response.
    if (request.id === undefined) continue;
    handle(request).then(
      (result) => send({ id: request.id, result }),
      (error: Error & { code?: number }) =>
        send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  }
});
