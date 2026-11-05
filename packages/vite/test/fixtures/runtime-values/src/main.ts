import { cn, css } from '@pre.style/core';

const bar = (width?: number | null) => css`
  width: var(${width}px, 120px);
  height: 1px;
`;

export const withValue = bar(240);
export const again = bar(240);
export const withNull = bar(null);
export const invalid = () => bar(false as unknown as number);

export const order: string[] = [];
export const inOrder = css`
  margin-top: ${order.push('first')}px;
  margin-left: ${order.push('second')}px;
`;

export const merged = cn(bar(1), bar(2));
