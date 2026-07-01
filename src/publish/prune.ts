import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { BatchHistoryEntry, ProjectPaths, RunConfig, StateBundle } from "../shared/types.js";

const MAX_BATCH_ARCHIVES = 21;

function compareEntriesDesc(left: BatchHistoryEntry, right: BatchHistoryEntry): number {
  return right.generatedAt.localeCompare(left.generatedAt);
}

export async function pruneBatchArtifacts(
  state: StateBundle,
  paths: ProjectPaths,
  config: RunConfig
): Promise<StateBundle> {
  const cutoff = new Date(config.generatedAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - config.historyDays);

  const keptEntries = [...state.batches.entries]
    .sort(compareEntriesDesc)
    .filter((entry) => new Date(entry.generatedAt) >= cutoff)
    .slice(0, MAX_BATCH_ARCHIVES);

  const keepIds = new Set(keptEntries.map((entry) => entry.batchId));
  state.batches.entries = keptEntries;
  state.batches.latestBatchId = state.batches.latestBatchId && keepIds.has(state.batches.latestBatchId)
    ? state.batches.latestBatchId
    : keptEntries[0]?.batchId ?? null;

  const batchesDir = path.join(paths.distDir, "batches");
  try {
    const dirEntries = await readdir(batchesDir, { withFileTypes: true });
    await Promise.all(
      dirEntries
        .filter((entry) => entry.isDirectory() && !keepIds.has(entry.name))
        .map((entry) => rm(path.join(batchesDir, entry.name), { recursive: true, force: true }))
    );
  } catch {
    // Nothing to prune yet.
  }

  return state;
}
