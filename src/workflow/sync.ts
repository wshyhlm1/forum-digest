import path from "node:path";

import { loadAppEnv, getProjectPaths } from "../shared/config.js";
import type {
  BatchHistoryEntry,
  BatchManifest,
  BatchPushRecord,
  SourceStatusMap,
  StoryRecord,
  StorySource
} from "../shared/types.js";
import { fetchStories } from "../fetch/index.js";
import { pruneBatchArtifacts } from "../publish/prune.js";
import { loadStateBundle, saveStateBundle } from "../publish/state.js";
import { renderSite } from "../render/index.js";
import { renderHnPublicDigest } from "../render/hn-public.js";
import { writeJsonFile } from "../shared/fs.js";
import { translateStories } from "../translate/index.js";
import { notifyBatch } from "../notify/index.js";
import type { RunConfig } from "../shared/types.js";

const SOURCE_ORDER: StorySource[] = ["hackernews", "v2ex", "linuxdo"];

function dailyBriefSourceId(source: StorySource): string {
  switch (source) {
    case "hackernews":
      return "hackernews";
    case "v2ex":
      return "v2ex-hot";
    case "linuxdo":
      return "linuxdo";
    default:
      return source;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildSummaryZhShort(story: StoryRecord): string {
  const text = normalizeText([...story.summaryZh, ...story.highlightsZh].filter(Boolean).join(" "));
  return text.length > 220 ? `${text.slice(0, 220).trim()}...` : text;
}

function buildSourceStatus(config: RunConfig, stories: StoryRecord[], sourceStatus?: SourceStatusMap): SourceStatusMap {
  return SOURCE_ORDER.reduce((status, source) => {
    const count = stories.filter((story) => story.source === source).length;
    const current = sourceStatus?.[source];
    status[source] = {
      ok: current?.ok ?? true,
      count,
      ...(current?.error ? { error: current.error } : {}),
      attemptedAt: current?.attemptedAt ?? config.generatedAt
    };
    return status;
  }, {} as SourceStatusMap);
}

function createFallbackManifest(config: RunConfig, stories: StoryRecord[], sourceStatus?: SourceStatusMap): BatchManifest {
  const batchUrl = new URL(`batches/${config.batchId}/`, config.siteBaseUrl).toString();
  const push: BatchPushRecord = { status: "pending", messageUrl: batchUrl };
  const sourceCounts: Record<StorySource, number> = {
    hackernews: stories.filter((story) => story.source === "hackernews").length,
    v2ex: stories.filter((story) => story.source === "v2ex").length,
    linuxdo: stories.filter((story) => story.source === "linuxdo").length
  };

  return {
    schemaVersion: 1,
    batchId: config.batchId,
    timezone: config.timezone,
    slot: config.slot,
    generatedAt: config.generatedAt,
    targetDate: config.targetDate,
    storyCount: stories.length,
    sourceCounts,
    sourceStatus: buildSourceStatus(config, stories, sourceStatus),
    latestIndexUrl: config.siteBaseUrl,
    batchUrl,
    stories: stories.map((story) => ({
      id: story.id,
      storyKey: story.storyKey,
      source: story.source,
      dailyBriefSourceId: dailyBriefSourceId(story.source),
      sourceLabel: story.sourceLabel,
      rank: story.rank,
      sourceRank: story.sourceRank,
      title: story.title,
      titleZh: story.titleZh,
      digestUrl: new URL(`stories/${story.storyKey}.html`, config.siteBaseUrl).toString(),
      storyUrl: new URL(`stories/${story.storyKey}.html`, config.siteBaseUrl).toString(),
      storyJsonUrl: new URL(`stories/${story.storyKey}.json`, config.siteBaseUrl).toString(),
      hnUrl: story.hnUrl,
      discussionUrl: story.discussionUrl,
      sourceUrl: story.url || story.discussionUrl,
      publishedAt: story.publishedAt,
      score: story.score,
      commentsCount: story.commentsCount,
      category: story.category,
      summaryZhShort: buildSummaryZhShort(story),
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
  const fetched = await fetchStories(config, env);
  const translated = await translateStories(fetched.stories, config, state, env);
  const renderResult = await renderSite(translated.stories, config, paths, fetched.sourceStatus).catch(() => ({
    manifest: createFallbackManifest(config, translated.stories, fetched.sourceStatus)
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
    await writeJsonFile(path.join(paths.distDir, "latest.json"), manifest);
    await writeJsonFile(path.join(paths.distDir, "batches", "latest", "manifest.json"), manifest);
    await saveStateBundle(paths, notifyResult.state);
  } else {
    await saveStateBundle(paths, nextState);
  }

  return manifest;
}
