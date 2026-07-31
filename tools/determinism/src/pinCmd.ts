// Thin client for the pin:drive control server.
//
//   bun run pin:cmd goto '{"map":"la-cantina","render":"mesh"}'
//   bun run pin:cmd fly  '{"x":120,"y":48,"z":150,"yaw":1.57,"pitch":-0.6}'
//   bun run pin:cmd pin  '{"notes":"turret sits beside its pad, not on it"}'
//   bun run pin:cmd reshoot '{"id":"latest"}'
//   bun run pin:cmd verbs
//
// Nicer than raw curl: it validates the JSON before the round trip, names the
// failure when the driver is not running, and exits non-zero on a driver error
// so a script can branch on it.

// No imports, so `export {}` is what makes the top-level await below legal.
export {};

const CONTROL = `http://127.0.0.1:${process.env.PIN_DRIVE_CONTROL_PORT ?? "8788"}`;

async function main(): Promise<void> {
  const [verb, rawArgs] = process.argv.slice(2);
  if (!verb) {
    console.error("usage: bun run pin:cmd <verb> ['<json args>']");
    console.error("       bun run pin:cmd verbs        # list what the driver accepts");
    process.exit(2);
  }

  if (verb === "verbs" || verb === "health") {
    const res = await fetch(`${CONTROL}/health`).catch(() => null);
    if (!res) {
      console.error(`pin:drive not reachable on ${CONTROL} — start it with: bun run pin:drive`);
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  let args: unknown = {};
  if (rawArgs !== undefined && rawArgs.length > 0) {
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      console.error(`args must be JSON: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }

  const res = await fetch(`${CONTROL}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, args }),
  }).catch(() => null);
  if (!res) {
    console.error(`pin:drive not reachable on ${CONTROL} — start it with: bun run pin:drive`);
    process.exit(1);
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  console.log(JSON.stringify(body, null, 2));
  process.exit(res.ok && body.ok !== false ? 0 : 1);
}

await main();
