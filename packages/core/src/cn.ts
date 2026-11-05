import { SHORTHANDS } from './shorthands.ts';

// Classes grouped by prefix, then by the property they set, as
// space-separated class names. Classes under the same at-rules and selector
// variant share a prefix; classes on the element have an empty one. Grouping
// writes each prefix and property once, which keeps the table small in the
// bundle.
export type CnTable = Record<string, Record<string, string>>;

// Each class's prefix and property.
export type CnLookup = Map<string, readonly [prefix: string, property: string]>;

export type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | ClassDictionary
  | ClassValue[];
export type ClassDictionary = Record<string, unknown>;

// clsx-style arguments, flattened into classes.
function collect(value: ClassValue, classes: string[]) {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    for (const c of String(value).split(/\s+/)) if (c) classes.push(c);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, classes);
  } else if (typeof value === 'object') {
    for (const [key, on] of Object.entries(value)) if (on) collect(key, classes);
  }
}

// Removes earlier classes that later ones override: two classes conflict
// when they have the same prefix and set the same property. A later
// shorthand also removes earlier longhands it covers. Classes not in the
// table are kept.
function resolve(classes: string[], lookup: CnLookup): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let i = classes.length - 1; i >= 0; i--) {
    const c = classes[i];
    if (seen.has(c)) continue;
    seen.add(c);
    const entry = lookup.get(c);
    if (entry !== undefined) {
      const [prefix, property] = entry;
      const key = `${prefix} ${property}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Object.hasOwn(SHORTHANDS, property))
        for (const longhand of SHORTHANDS[property]) seen.add(`${prefix} ${longhand}`);
    }
    kept.push(c);
  }
  return kept.toReversed();
}

export function createCn(
  table: CnTable,
  // Filled from the table. `generatedClasses` passes one that also knows
  // classes generated at runtime.
  lookup: CnLookup = new Map(),
): (...inputs: ClassValue[]) => string {
  for (const [prefix, properties] of Object.entries(table))
    for (const [property, classes] of Object.entries(properties))
      for (const c of classes.split(' ')) lookup.set(c, [prefix, property]);
  return (...inputs) => {
    const classes: string[] = [];
    collect(inputs, classes);
    return resolve(classes, lookup).join(' ');
  };
}
