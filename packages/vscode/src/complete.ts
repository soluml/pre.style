import {
  getCSSLanguageService,
  getSCSSLanguageService,
  type CompletionList,
  type CompletionSettings,
  type LanguageService,
  type LanguageServiceOptions,
} from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { blockStylesheet, findBlockAt, type BlockLanguage } from './blocks.ts';

const options: LanguageServiceOptions = {
  clientCapabilities: {
    textDocument: {
      completion: {
        completionItem: { documentationFormat: ['markdown', 'plaintext'] },
      },
    },
  },
};

// Created on first use: loading the CSS data takes a moment.
const services: Partial<Record<BlockLanguage, LanguageService>> = {};

function service(language: BlockLanguage): LanguageService {
  return (services[language] ??=
    language === 'css' ? getCSSLanguageService(options) : getSCSSLanguageService(options));
}

export interface BlockCompletions {
  language: BlockLanguage;
  list: CompletionList;
}

/** Completions at `offset` if it's inside a block, with ranges in `text`'s positions. */
export function completeInBlock(
  text: string,
  offset: number,
  html: boolean,
  settings?: (language: BlockLanguage) => CompletionSettings | undefined,
): BlockCompletions | undefined {
  const block = findBlockAt(text, offset, html);
  if (!block) return undefined;
  // Inside `${…}` is JavaScript, which VS Code's own language service handles.
  if (block.expressions.some(([start, end]) => offset > start && offset < end)) return undefined;
  const doc = TextDocument.create(
    'pre-style://block',
    block.language,
    0,
    blockStylesheet(text, block),
  );
  const ls = service(block.language);
  const list = ls.doComplete(
    doc,
    doc.positionAt(offset),
    ls.parseStylesheet(doc),
    settings?.(block.language),
  );
  return { language: block.language, list };
}
