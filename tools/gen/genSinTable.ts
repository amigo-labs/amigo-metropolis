// Generates packages/sim/src/sinTable.ts — the committed sin lookup table.
//
// This is the ONLY place Math.sin is ever called in the project. It runs at
// authoring time on a developer machine; the emitted literals are committed so
// every peer loads bit-identical constants (docs/specs/architecture.md §2).
// Number.prototype.toString produces the shortest round-trip representation,
// so parsing the literals recovers the exact IEEE-754 doubles.
//
// Usage: bun tools/gen/genSinTable.ts

const BITS = 12;
const SIZE = 1 << BITS;

const values: string[] = [];
for (let i = 0; i < SIZE; i++) {
  values.push(Math.sin((i * 2 * Math.PI) / SIZE).toString());
}

const lines: string[] = [];
lines.push("// GENERATED FILE — do not edit by hand. Regenerate with:");
lines.push("//   bun tools/gen/genSinTable.ts");
lines.push("// Committed constants so all peers share bit-identical values;");
lines.push("// see docs/specs/architecture.md §2 and CLAUDE.md determinism rules.");
lines.push(`export const SIN_TABLE_BITS = ${BITS};`);
lines.push(`export const SIN_TABLE_SIZE = ${SIZE};`);
lines.push(`export const SIN_TABLE_MASK = ${SIZE - 1};`);
lines.push("// prettier-ignore");
lines.push("export const SIN_TABLE: Float64Array = new Float64Array([");
for (let i = 0; i < SIZE; i += 8) {
  lines.push(`  ${values.slice(i, i + 8).join(", ")},`);
}
lines.push("]);");
lines.push("");

await Bun.write(new URL("../../packages/sim/src/sinTable.ts", import.meta.url), lines.join("\n"));
console.log(`wrote sinTable.ts (${SIZE} entries)`);
