import "../shared/proxy.js";
import { createRunConfig } from "../shared/config.js";
import { runBuildPipeline } from "../workflow/build.js";

async function main(): Promise<void> {
  const config = createRunConfig(process.argv.slice(2));
  await runBuildPipeline(config);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
