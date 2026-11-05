import { useEffect, useState, type CSSProperties } from 'react';
import { css } from '@pre.style/core';

const counter = css`
  counter-reset: count var(--count, 0);
  font-size: 3rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  margin: 0;

  &::before {
    content: counter(count);
  }
`;

const output = css`
  font-family: var(--font-mono);
  font-size: 0.875rem;
`;

// A value that changes constantly, which suits `style`: the block is static, so
// its class never changes, no rules are added, and the runtime isn't involved.
export function StyleCounter() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setI((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <p className={counter} data-demo="counter" style={{ '--count': i } as CSSProperties} />
      <p>
        Class: <code className={output}>{counter}</code>
      </p>
    </>
  );
}
