import { ColorPicker, StyleCounter } from 'pre.style-demo-react-ui';
import type { Route } from './+types/interpolation';

export const meta: Route.MetaFunction = () => [{ title: 'Interpolation · pre.style demo' }];

export default function Interpolation() {
  return (
    <>
      <h1>Interpolation</h1>
      <p>
        There are two ways to set a value at runtime. They suit different values, and the class
        shown under each example shows the difference.
      </p>
      <h2>
        <code>{'${…}'}</code>, for values from a small set
      </h2>
      <p>
        Each distinct value gets its own generated class and rule, so the class changes with the
        value. Going back to a color reuses its class. It works with <code>cn</code>, but each new
        value adds a rule that's never removed. The server renders the block's default until the
        runtime takes over in the browser.
      </p>
      <ColorPicker />
      <h2>
        <code>style</code>, for values that change constantly
      </h2>
      <p>
        The block is static and reads a custom property that <code>style</code> sets, so the class
        never changes, no rules are added, and no runtime is needed. The server renders the real
        value too.
      </p>
      <StyleCounter />
    </>
  );
}
