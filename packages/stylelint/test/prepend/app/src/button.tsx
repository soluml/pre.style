import { css, scss } from '@pre.style/core';

export const button = css`
  color: var(--brand);
  margin: var(--gap);
  animation: spin 1s;
  outline-color: var(--accent);
  @media (--narrow) {
    display: none;
  }
`;

export const card = scss`
  @include fancy;
  padding: var(--gap);
  border-color: var(--missing);
`;
