import { load } from "@std/dotenv";
await load({ export: true });

const command = Deno.args[0];

if (command === "ingest") {
  const { runIngest } = await import("./src/ingest/ingest.ts");
  await runIngest();
} else if (command === "serve") {
  const { startServer } = await import("./src/server/server.ts");
  await startServer();
} else {
  console.error("Usage: deno task ingest | serve");
  Deno.exit(1);
}
