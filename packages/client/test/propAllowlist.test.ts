// The client keeps a literal copy of UNAVAILABLE_PROP_COBJS (render/props.ts
// must not import tools/ at runtime); this pins the copy to the manifest's
// canonical list so the day a raw lands and the manifest entry moves, the
// client's skip-list fails loudly instead of silently dropping placements.
// Same cross-workspace test import precedent as fxAtlas.test.ts.

import { describe, expect, test } from "bun:test";
import { UNAVAILABLE_PROP_COBJS as MANIFEST_LIST } from "../../../tools/generators/units/manifest";
import { UNAVAILABLE_PROP_COBJS as CLIENT_SET } from "../src/render/props";

describe("unavailable-prop allowlist", () => {
  test("the client's literal copy matches the manifest's canonical list", () => {
    expect([...CLIENT_SET].sort((a, b) => a - b)).toEqual([...MANIFEST_LIST].sort((a, b) => a - b));
  });
});
