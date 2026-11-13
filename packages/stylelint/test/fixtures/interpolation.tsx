import { css, scss } from '@pre.style/core';

export function Box({ w, a, b, x, d, img, n, theme, wide }: Record<string, any>) {
  return css`
    width: ${w}px;
    margin: ${a} ${b};
    color: ${theme.color};
    padding: 0 ${x};
    transition: opacity ${d}ms ease;
    background: url(${img});
    height: ${
      wide ? '2px' : '1px'
    };
    min-width: ${`${n}px`};
    max-width: ${/* } */ n};
    border: 1px solid ${theme.border};
    font-size: calc(${n} * 1px);
    outline: 0px solid ${theme.border};
  `;
}

export const Card = ({ gap }: { gap: number }) => scss`
  $base: 4px;
  margin: calc(${gap} + $base);
  padding: ${gap}em;
`;
