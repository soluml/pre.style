import { CASE_INSENSITIVE, CASE_SENSITIVE, create } from './runtime.ts';
import type { InvalidValue } from './runtime.ts';

// `./runtime.ts` with full error messages, which the bundler plugin uses
// outside production builds.
const invalidValue: InvalidValue = (value, strings) => {
  const got = typeof value === 'number' ? String(value) : typeof value;
  throw new TypeError(
    `pre.style: \`\${…}\` values must be strings or numbers, or null or undefined to use the default. Got ${got} in \`${strings.join('${…}')}\`. For a condition, write \`\${open ? width : null}\` rather than \`\${open && width}\`.`,
  );
};

export const dynamic = /* @__PURE__ */ create(CASE_SENSITIVE, invalidValue);
export const dynamicLowercase = /* @__PURE__ */ create(CASE_INSENSITIVE, invalidValue);
