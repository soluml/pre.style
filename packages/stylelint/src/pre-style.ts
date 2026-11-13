import type { Config } from 'stylelint';
import type { LightningOptions } from '@pre.style/core/compiler';
import compile, { ruleName } from './rules/compile.ts';
import { createSyntax } from './syntax.ts';
import { languageOptions, prependOverrides, type PrependOptions } from './config.ts';
import type { ScopeOptions } from './stylesheets.ts';

export interface PreStyleOptions extends PrependOptions, ScopeOptions {
  // Passed to Lightning CSS when blocks are compiled, as the bundler plugin's
  // `lightningcss` option (its `errorRecovery`, for example).
  lightningcss?: LightningOptions;
}

// pre.style's Stylelint config: the syntax that finds blocks, `composes`,
// prepended files as reference files, and `pre-style/compile`. It sets no
// style rules. Put it last in `extends`, after configs (such as
// `stylelint-config-standard-scss`) that set their own `customSyntax`.
export function preStyle(options: PreStyleOptions = {}): Config {
  const { include, exclude, lightningcss, ...prepend } = options;
  return {
    plugins: [compile],
    customSyntax: createSyntax({ include, exclude }),
    languageOptions,
    rules: { [ruleName]: lightningcss === undefined ? true : [true, { lightningcss }] },
    overrides: prependOverrides(prepend),
  };
}
