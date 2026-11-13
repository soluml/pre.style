import { css, scss } from '@pre.style/core';

export const tag = css;

export const undefinedVariable = scss`
  margin: $nope;
`;

export const invalid = css`
  color: red;
  &:::x {
    color: blue;
  }
`;

export const selector = (x: string) => css`
  &:${x} {
    color: red;
  }
`;

export const placement = css`
  color: red;
  composes: a from global;
`;
