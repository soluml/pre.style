import * as vscode from 'vscode';
import type { BlockLanguage } from './blocks.ts';
import type { PrependedFile } from './complete.ts';
import { prependPaths } from './field.ts';

const decoder = new TextDecoder();

// Disk reads, by URI, until a package.json, .css, or .scss file changes.
const cache = new Map<string, Promise<string | undefined>>();

function readCached(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  let text = cache.get(key);
  if (!text) {
    text = Promise.resolve(vscode.workspace.fs.readFile(uri)).then(
      (bytes) => decoder.decode(bytes),
      () => undefined,
    );
    cache.set(key, text);
  }
  return text;
}

// An open document's text, so unsaved edits count.
async function read(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  return open ? open.getText() : readCached(uri);
}

/**
 * The files prepended to `language`'s blocks in `document`: those of the
 * nearest package.json, the app's or a library's, as the build prepends each
 * package's own.
 */
export async function prependedFiles(
  document: vscode.TextDocument,
  language: BlockLanguage,
): Promise<PrependedFile[]> {
  if (document.uri.scheme === 'untitled') return [];
  for (let dir = vscode.Uri.joinPath(document.uri, '..'); ;) {
    const pkg = await read(vscode.Uri.joinPath(dir, 'package.json'));
    if (pkg !== undefined) {
      const files = await Promise.all(
        prependPaths(pkg, language).map(async (path) => {
          const uri = vscode.Uri.joinPath(dir, path);
          const text = await read(uri);
          return text === undefined ? undefined : { uri: uri.toString(), text };
        }),
      );
      return files.filter((f) => f !== undefined);
    }
    const parent = vscode.Uri.joinPath(dir, '..');
    if (parent.path === dir.path) return [];
    dir = parent;
  }
}

export function watchPrepended(context: vscode.ExtensionContext) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/{package.json,*.css,*.scss}');
  const clear = () => cache.clear();
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(clear),
    watcher.onDidCreate(clear),
    watcher.onDidDelete(clear),
  );
}
