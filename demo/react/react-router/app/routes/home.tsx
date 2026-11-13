import { css } from '@pre.style/core';
import { Badge, Button } from 'pre.style-demo-react-ui';
import type { Route } from './+types/home';

export const meta: Route.MetaFunction = () => [{ title: 'Basics · pre.style demo' }];

const title = css`
  font-size: 2rem;
  line-height: 1.2;
  margin: 0 0 calc(var(--space) * 2);

  @media (width >= 768px) {
    font-size: 2.75rem;
  }
`;

const lead = css`
  color: var(--color-muted);
  font-size: 1.125rem;
  margin: 0 0 calc(var(--space) * 8);
`;

// A container query: cards switch to two columns when the grid is wide
// enough, whatever the viewport.
const grid = css`
  container-type: inline-size;
`;

const cards = css`
  display: grid;
  gap: calc(var(--space) * 4);

  @container (min-width: 36rem) {
    grid-template-columns: repeat(2, 1fr);
  }
`;

const card = css`
  background-color: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: calc(var(--space) * 5);
  transition: transform 150ms ease, box-shadow 150ms ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgb(0 0 0 / 8%);
  }

  & > h2 {
    font-size: 1.125rem;
    margin: 0 0 var(--space);
  }

  & > p {
    color: var(--color-muted);
    margin: 0;
  }
`;

const pulse = css`
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }

  animation: pulse 2s ease-in-out infinite;
  color: var(--color-accent);
`;

const arrow = css`
  &::after {
    content: ' →';
  }
`;

const FEATURES = [
  ['Atomic classes', 'Every declaration is one class, shared by every block that uses it.'],
  ['Selector variants', 'Hover a card: `&:hover` and `& > h2` become their own classes.'],
  ['Container queries', 'This grid switches to two columns with `@container`, not the viewport.'],
  ['Server rendered', 'The same class strings render on the server and hydrate in the browser.'],
];

export default function Home() {
  return (
    <>
      <h1 className={title}>pre.style, dogfooded</h1>
      <p className={lead}>
        Every style on this site is a <code>css</code> or <code>scss</code> block, compiled to
        atomic classes at build time. <span className={pulse}>No runtime.</span>
      </p>
      <div className={grid}>
        <div className={cards}>
          {FEATURES.map(([heading, text]) => (
            <article key={heading} className={card}>
              <h2>{heading}</h2>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
      <p
        className={css`
          margin-top: calc(var(--space) * 8);
        `}
      >
        <Button className={arrow}>A button with an ::after</Button>{' '}
        <Badge tone="accent">Styled from a .scss file</Badge>
      </p>
    </>
  );
}
