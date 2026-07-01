import "../shared/proxy.js";
import { createRunConfig, getProjectPaths } from "../shared/config.js";
import { captureHnSnapshot } from "../snapshot/hn.js";

async function main(): Promise<void> {
  const config = createRunConfig(process.argv.slice(2));
  const snapshot = await captureHnSnapshot(config, getProjectPaths());
  process.stdout.write(`${JSON.stringify({
    date: snapshot.date,
    storyCount: Object.keys(snapshot.stories).length,
    updatedAt: snapshot.updatedAt,
    runs: snapshot.runs.length
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
