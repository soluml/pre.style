/** @jsxRuntime classic @jsx h */
import { css } from '@pre.style/core';

declare function h(...args: unknown[]): unknown;
declare function Card(props: { className: string }): unknown;

const box = css`padding: 1rem;`;

export const app = (
  <main className={box}>
    <Card className={css`color: red;`} />
    <ui.Badge class="plain" />
    <span>no class</span>
  </main>
);
declare const ui: { Badge(props: { class: string }): unknown };
