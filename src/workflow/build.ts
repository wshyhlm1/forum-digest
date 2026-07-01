import type { RunConfig } from "../shared/types.js";
import { runSyncPipeline } from "./sync.js";

export async function runBuildPipeline(config: RunConfig): Promise<void> {
  await runSyncPipeline({
    ...config,
    skipPush: true
  });
}
