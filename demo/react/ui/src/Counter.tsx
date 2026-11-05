import { useEffect, useState } from 'react';
import { css } from '@pre.style/core';

const counter = css`
  font-size: 3rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  margin: 0;
`;

// Counts up once a second. The count is a runtime value, sent to a custom
// property that the block's `&::before` reads, so the number is only ever in
// the CSS. The default shows until the runtime runs in the browser.
export function Counter() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setI((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const myCSS = css`
    &::before {
      content: var(${JSON.stringify(String(i))}, '0');
    }
  `;

  return <p className={`${counter} ${myCSS}`} />;
}
