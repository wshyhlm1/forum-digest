import path from "node:path";

import { loadAppEnv, getProjectPaths } from "../shared/config.js";
import type { BatchHistoryEntry, BatchManifest, BatchPushRecord, StoryRecord, StorySource } from "../shared/types.js";
import { fetchStories } from "../fetch/index.js";
import { pruneBatchArtifacts } from "../publish/prune.js";
import { loadStateBundle, saveStateBundle } from "../publish/state.js";
import { renderSite } from "../render/index.js";
import { renderHnPublicDigest } from "../render/hn-public.js";
import { writeJsonFile } from "../shared/fs.js";
import { translateStories } from "../translate/index.js";
import { notifyBatch } from "../notify/index.js";
import type { RunConfig } from "../shared/types.js";

function createFallbackManifest(config: RunConfig, stories: StoryRecord[]): BatchManifest {
  const batchUrl = new URL(`batches/${config.batchId}/`, config.siteBaseUrl).toString();
  const push: BatchPushRecord = { status: "pending", messageUrl: batchUrl };
  const sourceCounts: Record<StorySource, number> = {
    hackernews: stories.filter((story) => story.source === "hackernews").length,
    v2ex: stories.filter((story) => story.source === "v2ex").length,
    linuxdo: stories.filter((story) => story.source === "linuxdo").length
  };

  return {
    batchId: config.batchId,
    timezone: config.timezone,
    slot: config.slot,
    generatedAt: config.generatedAt,
    targetDate: config.targetDate,
    storyCount: stories.length,
    sourceCounts,
    latestIndexUrl: config.siteBaseUrl,
    batchUrl,
    stories: stories.map((story) => ({
      id: story.id,
      storyKey: story.storyKey,
      source: story.source,
      sourceLabel: story.sourceLabel,
      rank: story.rank,
      sourceRank: story.sourceRank,
      title: story.title,
      titleZh: story.titleZh,
      storyUrl: new URL(`stories/${story.storyKey}.html`, config.siteBaseUrl).toString(),
      storyJsonUrl: new URL(`stories/${story.storyKey}.json`, config.siteBaseUrl).toString(),
      hnUrl: story.hnUrl,
      discussionUrl: story.discussionUrl,
      sourceUrl: story.url,
      score: story.score,
      commentsCount: story.commentsCount,
      category: story.category,
      relevanceReason: story.relevanceReason,
      summaryZh: story.summaryZh,
      highlightsZh: story.highlightsZh,
      translationStatus: story.translationStatus
    })),
    push
  };
}

export async function runSyncPipeline(config: RunConfig): Promise<BatchManifest> {
  const env = loadAppEnv();
  const paths = getProjectPaths();
  const state = await loadStateBundle(paths);
  const stories = await fetchStories(config, env);
  const translated = await translateStories(stories, config, state, env);
  const renderResult = await renderSite(translated.stories, config, paths).catch(() => ({
    manifest: createFallbackManifest(config, translated.stories)
  }));
  await renderHnPublicDigest(translated.stories, config, paths);

  const manifest = renderResult.manifest;
  const nextState = translated.state;
  nextState.batches.latestBatchId = manifest.batchId;

  const historyEntry: BatchHistoryEntry = {
    batchId: manifest.batchId,
    slot: manifest.slot,
    generatedAt: manifest.generatedAt,
    batchUrl: manifest.batchUrl,
    storyCount: manifest.storyCount
  };

  nextState.batches.entries = [historyEntry, ...nextState.batches.entries.filter((item) => item.batchId !== historyEntry.batchId)];
  await pruneBatchArtifacts(nextState, paths, config);

  if (!config.skipPush && !config.dryRun) {
    const notifyResult = await notifyBatch(manifest, config, nextState, env);
    await writeJsonFile(path.join(paths.distDir, "batches", manifest.batchId, "manifest.json"), manifest);
    await saveStateBundle(paths, notifyResult.state);
  } else {
    await saveStateBundle(paths, nextState);
  }

  return manifest;
}
