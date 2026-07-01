import "../shared/proxy.js";
import { createRunConfig } from "../shared/config.js";
import { runNotifyPipeline } from "../workflow/notify.js";

async function main(): Promise<void> {
  const config = createRunConfig(process.argv.slice(2));
  await runNotifyPipeline(config);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
