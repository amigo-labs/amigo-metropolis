// Local verification-pin receiver. Fly-mode client POSTs pin.json + its shots +
// prompt.txt; pinStore writes docs/verification/pins/<id>/ and refreshes latest/.
//
//   bun run pin:serve          # from repo root
//
// The endpoints live in pinReceiver.ts because pin:drive serves the identical
// ones for its own headless client. Loopback only. No auth. Debug tooling.

import { join } from "node:path";
import { servePinReceiver } from "./pinReceiver";
import { createPinStore } from "./pinStore";

const PORT = Number(process.env.PIN_SERVER_PORT ?? "8787");
const ROOT = join(import.meta.dir, "..", "..", "..");
const PINS = join(ROOT, "docs", "verification", "pins");

const server = servePinReceiver(createPinStore(PINS), PORT);

console.log(`[pin] listening on http://127.0.0.1:${server.port}`);
console.log(`[pin] writing to ${PINS}`);
