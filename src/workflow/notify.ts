import path from "node:path";

import { loadAppEnv, getProjectPaths } from "../shared/config.js";
import type { BatchManifest, RunConfig } from "../shared/types.js";
import { readJsonFile, writeJsonFile } from "../shared/fs.js";
import { loadStateBundle, saveStateBundle } from "../publish/state.js";
import { notifyBatch } from "../notify/index.js";

function createManifestFromHistory(config: RunConfig): BatchManifest {
  const batchUrl = new URL(`batches/${config.batchId}/`, config.siteBaseUrl).toString();
  return {
    schemaVersion: 1,
    batchId: config.batchId,
    timezone: config.timezone,
    slot: config.slot,
    generatedAt: config.generatedAt,
    targetDate: config.targetDate,
    storyCount: 0,
    sourceCounts: {
      hackernews: 0,
      v2ex: 0,
      linuxdo: 0
    },
    sourceStatus: {
      hackernews: { ok: true, count: 0, attemptedAt: config.generatedAt },
      v2ex: { ok: true, count: 0, attemptedAt: config.generatedAt },
      linuxdo: {
        ok: true,
        count: 0,
        disabled: true,
        reason: "linuxdo source disabled by project decision",
        attemptedAt: config.generatedAt
      }
    },
    latestIndexUrl: config.siteBaseUrl,
    batchUrl,
    stories: [],
    push: {
      status: "pending",
      messageUrl: batchUrl
    }
  };
}

export async function runNotifyPipeline(config: RunConfig): Promise<void> {
  const env = loadAppEnv();
  const paths = getProjectPaths();
  const state = await loadStateBundle(paths);
  const hasMatchingBatch = state.batches.entries.some((entry) => entry.batchId === config.batchId);
  const latestBatchId = hasMatchingBatch ? config.batchId : state.batches.latestBatchId;

  if (!latestBatchId) {
    throw new Error("No batch is available for notification.");
  }

  const manifestPath = path.join(paths.distDir, "batches", latestBatchId, "manifest.json");
  const manifest = await readJsonFile(
    manifestPath,
    createManifestFromHistory({
      ...config,
      batchId: latestBatchId
    })
  );
  const result = await notifyBatch(manifest, config, state, env);
  await writeJsonFile(manifestPath, manifest);
  await writeJsonFile(path.join(paths.distDir, "latest.json"), manifest);
  await writeJsonFile(path.join(paths.distDir, "batches", "latest", "manifest.json"), manifest);
  await saveStateBundle(paths, result.state);
}
