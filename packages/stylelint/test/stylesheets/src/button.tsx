// A plain CSS import, which doesn't make a pre.style stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import './global.css';
import { css } from '@pre.style/core';
import { button } from './button.css' with { type: 'pre.style' };

export const primary = css`
  composes: base from '../shared/base.css';
  color: red;
`;

export { button };
