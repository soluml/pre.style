import compile from './rules/compile.ts';

// pre.style's Stylelint rules, for `plugins`.
const plugins = [compile];

export default plugins;
export { preStyle, type PreStyleOptions } from './pre-style.ts';
export { createSyntax } from './syntax.ts';
export { languageOptions, prependOverrides, type PrependOptions } from './config.ts';
export type { ScopeOptions } from './stylesheets.ts';
export type { CompileOptions } from './rules/compile.ts';
