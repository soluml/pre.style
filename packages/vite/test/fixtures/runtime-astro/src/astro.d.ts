// What the fake Astro compiler in the tests exports from Card.astro.
declare module '*.astro' {
  export const card: string;
  export const both: string;
}
