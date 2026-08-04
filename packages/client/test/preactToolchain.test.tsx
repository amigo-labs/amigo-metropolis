import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";

function Hello({ name }: { name: string }) {
  return <p class="x">{name}</p>;
}

test("preact renders to string and escapes children", () => {
  // `<` and `&` are escaped, which is what closes the injection; a bare `>` in
  // a text node cannot open a tag, so preact leaves it alone.
  expect(render(<Hello name="<img onerror=x>" />)).toBe('<p class="x">&lt;img onerror=x></p>');
});
