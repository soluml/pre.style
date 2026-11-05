import { useState } from 'react';
import { css } from '@pre.style/core';
import { Button } from './Button';

const COLORS = { Red: '#d33', Green: '#2a7', Blue: '#36c' };

const controls = css`
  display: flex;
  gap: calc(var(--space) * 2);
  margin-block: calc(var(--space) * 3);
`;

const output = css`
  font-family: var(--font-mono);
  font-size: 0.875rem;
`;

// A value from a small set, which suits `${…}`: each color gets one generated
// class and rule, and going back to a color reuses them. The default shows until
// the runtime runs in the browser.
export function ColorPicker() {
  const [color, setColor] = useState(COLORS.Red);

  const swatch = css`
    background-color: var(${color}, #888);
    border-radius: var(--radius);
    color: white;
    margin: 0;
    padding: calc(var(--space) * 4);

    &::before {
      content: var('Picked: ${color}', 'Loading');
    }
  `;

  return (
    <>
      <div className={controls}>
        {Object.entries(COLORS).map(([name, value]) => (
          <Button key={name} variant="ghost" onClick={() => setColor(value)}>
            {name}
          </Button>
        ))}
      </div>
      <p className={swatch} data-demo="swatch" />
      <p>
        Class: <code className={output}>{swatch}</code>
      </p>
    </>
  );
}
