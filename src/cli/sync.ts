import "../shared/proxy.js";
import { createRunConfig } from "../shared/config.js";
import { runSyncPipeline } from "../workflow/sync.js";

async function main(): Promise<void> {
  const config = createRunConfig(process.argv.slice(2));
  const manifest = await runSyncPipeline(config);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
