import { cn, css } from '@pre.style/core';

const color = Math.random() > 0.5 ? 'red' : 'blue';

const first = css`
  --gap: 1px;
  margin-top: var(--gap);
  color: var(--shared);
`;

const second = css`
  --gap: 2px;
  margin-top: var(--gap);
`;

const third = css`
  --brand: ${color};
  color: var(--brand);
`;

document.body.className = cn(first, second, third);
