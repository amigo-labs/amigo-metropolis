import { describe, expect, it } from "bun:test";
import { SIM_VERSION } from "../src/index";

describe("workspace wiring", () => {
  it("exposes the sim version", () => {
    expect(SIM_VERSION).toBe(11);
  });
});
