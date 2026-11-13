import { css, scss as sass } from '@pre.style/core';
import styled from 'styled-components';

// Not a block: `css` here is styled-components'.
export const Other = styled.div`
  colour: red;
`;

export const button = css`
  color: #FFFFFF;
  padding: 0px;
  /* A comment. */
  &:hover {
    color: red
  }
`;

export const card = sass`
  $gap: 4px;
  // A Sass comment.
  margin: $gap;
  @include fancy;
`;

export const inline = css`color: red;`;
export const empty = css``;

export function Button() {
  return <button className={css`display: block;`}>{button}</button>;
}
