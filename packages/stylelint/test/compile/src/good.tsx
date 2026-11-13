import { css, scss } from '@pre.style/core';
import { card } from './card.css' with { type: 'pre.style' };

export const fancy = scss`
  @include fancy;
  margin: $gap;
`;

export const sized = (w: number) => css`
  width: ${w}px;
`;

export { card };
