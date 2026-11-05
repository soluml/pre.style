import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { css } from '@pre.style/core';
// pre.style's CSS. Vite bundles it in builds, and React Router links it when
// rendering on the server.
// oxlint-disable-next-line import/no-unassigned-import
import 'virtual:pre.style.css';

import type { Route } from './+types/root';

const body = css`
  background-color: var(--color-background);
  color: var(--color-text);
  font-family: var(--font-sans);
  line-height: 1.5;
  margin: 0;
`;

const header = css`
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-surface);
`;

const nav = css`
  display: flex;
  gap: calc(var(--space) * 6);
  align-items: center;
  max-width: 60rem;
  margin-inline: auto;
  padding: calc(var(--space) * 4) calc(var(--space) * 5);
`;

const brand = css`
  font-weight: 700;
  margin-right: auto;
`;

const link = css`
  color: var(--color-muted);
  text-decoration: none;

  &:hover {
    color: var(--color-text);
  }

  &[aria-current='page'] {
    color: var(--color-accent);
    font-weight: 600;
  }
`;

const main = css`
  max-width: 60rem;
  margin-inline: auto;
  padding: calc(var(--space) * 8) calc(var(--space) * 5);
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className={body}>
        <header className={header}>
          <nav className={nav}>
            <span className={brand}>pre.style demo</span>
            <NavLink to="/" end className={link}>
              Basics
            </NavLink>
            <NavLink to="/cn" className={link}>
              cn
            </NavLink>
            <NavLink to="/interpolation" className={link}>
              Interpolation
            </NavLink>
            <NavLink to="/server" className={link}>
              Server
            </NavLink>
          </nav>
        </header>
        <main className={main}>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'Something went wrong';
  const details = error instanceof Error && import.meta.env.DEV ? error.stack : undefined;
  return (
    <>
      <h1>{message}</h1>
      {details && (
        <pre
          className={css`
            overflow-x: auto;
            font-family: var(--font-mono);
          `}
        >
          {details}
        </pre>
      )}
    </>
  );
}
