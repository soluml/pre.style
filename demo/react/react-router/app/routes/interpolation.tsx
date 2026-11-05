import { Counter } from 'pre.style-demo-react-ui';
import type { Route } from './+types/interpolation';

export const meta: Route.MetaFunction = () => [{ title: 'Interpolation · pre.style demo' }];

export default function Interpolation() {
  return (
    <>
      <h1>Interpolation</h1>
      <p>
        This count is set with <code>{'${…}'}</code> in a block, and shown by its{' '}
        <code>&amp;::before</code>. Each value becomes a generated class that sets a custom
        property, using pre.style's small runtime. Blocks without <code>{'${…}'}</code> don't use
        it.
      </p>
      <Counter />
      <p>
        The server renders the default, <code>0</code>, and the runtime takes over in the browser.
        Each new value adds a rule that's never removed, so for values that change this often, a
        real app would use <code>style</code> instead.
      </p>
    </>
  );
}
