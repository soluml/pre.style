import { cn, css } from '@pre.style/core';

const a = css`color: red;`;
const b = css`color: blue;`;

export const merged = cn(a, Math.random() > 0.5 && b);
