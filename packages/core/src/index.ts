// `css` and `scss` have no runtime: the bundler plugin replaces every block
// with its class string at build time. These stubs exist so TypeScript can
// resolve the imports, and so code that missed the transform fails loudly.
function notTransformed(): never {
  throw new Error(
    'pre.style transform not applied. css and scss blocks must be compiled by a pre.style bundler plugin, such as @pre.style/vite.',
  );
}

export function css(_strings: TemplateStringsArray): string {
  return notTransformed();
}

export function scss(_strings: TemplateStringsArray): string {
  return notTransformed();
}

import { createCn } from './cn.ts';

// Without a project's lookup table, `cn` only combines classes and drops
// duplicates. The bundler plugin rewrites `cn` imports to a version bound
// to the project's table. Marked pure, so bundlers drop it once the imports
// are rewritten.
export const cn = /* @__PURE__ */ createCn({});
export { createCn };
export type { ClassDictionary, ClassValue, CnLookup, CnTable } from './cn.ts';
