import { parse } from 'jsonc-parser';
import type { BlockLanguage } from './blocks.ts';

/**
 * The paths a package.json's `pre.style` field prepends to `language`'s
 * blocks, relative to the package: an array applies to both languages.
 */
export function prependPaths(packageJson: string, language: BlockLanguage): string[] {
  const prependFiles = parse(packageJson)?.['pre.style']?.prependFiles;
  const paths = Array.isArray(prependFiles) ? prependFiles : prependFiles?.[language];
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
}
