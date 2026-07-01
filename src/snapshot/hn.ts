import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HN_BEST_STORIES_ENDPOINT,
  HN_ITEM_ENDPOINT,
  HN_TOP_STORIES_ENDPOINT
} from "../shared/constants.js";
import type { HnItemRecord, ProjectPaths, RunConfig } from "../shared/types.js";

type HnRankingSource = "topstories" | "beststories";

export interface HnSnapshotObservation {
  fetchedAt: string;
  source: HnRankingSource;
  rank: number;
  score: number;
  descendants: number;
}

export interface HnSnapshotStory {
  id: number;
  firstSeenAt: string;
  lastSeenAt: string;
  appearances: number;
  bestRank: number;
  bestRankSource: HnRankingSource;
  maxScore: number;
  maxDescendants: number;
  latest: HnItemRecord;
  observations: HnSnapshotObservation[];
}

export interface HnSnapshotRun {
  fetchedAt: string;
  topStoryCount: number;
  bestStoryCount: number;
}

export interface HnDailySnapshot {
  version: 1;
  date: string;
  timezone: string;
  updatedAt: string;
  runs: HnSnapshotRun[];
  stories: Record<string, HnSnapshotStory>;
}

export interface HnRankedSnapshotStory {
  id: number;
  rank: number;
  dailyHotScore: number;
  bestRank: number;
  bestRankSource: HnRankingSource;
  maxScore: number;
  maxDescendants: number;
  firstSeenAt: string;
  lastSeenAt: string;
  appearances: number;
}

const DEFAULT_SNAPSHOT: Omit<HnDailySnapshot, "date" | "timezone" | "updatedAt"> = {
  version: 1,
  runs: [],
  stories: {}
};

function snapshotPath(paths: ProjectPaths, date: string): string {
  return path.join(paths.stateDir, "hn-snapshots", `${date}.json`);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "forum-digest/1.0",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`HN official API fetch failed ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchStoryIds(endpoint: string, limit: number): Promise<number[]> {
  const payload = await fetchJson<unknown>(endpoint);
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .slice(0, limit);
}

async function fetchItemById(id: number): Promise<HnItemRecord | null> {
  try {
    return await fetchJson<HnItemRecord | null>(`${HN_ITEM_ENDPOINT}/${id}.json`);
  } catch {
    return null;
  }
}

function uniqueRankedIds(topIds: number[], bestIds: number[]): Array<{ id: number; topRank?: number; bestRank?: number }> {
  const records = new Map<number, { id: number; topRank?: number; bestRank?: number }>();
  topIds.forEach((id, index) => {
    records.set(id, { ...(records.get(id) ?? { id }), topRank: index + 1 });
  });
  bestIds.forEach((id, index) => {
    records.set(id, { ...(records.get(id) ?? { id }), bestRank: index + 1 });
  });
  return [...records.values()];
}

function dailyHotScore(story: HnSnapshotStory): number {
  const rankQuality = Math.max(0, 260 - story.bestRank * 2.8);
  const engagement = story.maxScore * 2 + story.maxDescendants * 3;
  const persistence = Math.min(80, story.appearances * 8);
  return Math.round((engagement + rankQuality + persistence) * 100) / 100;
}

function observeStory(
  snapshot: HnDailySnapshot,
  item: HnItemRecord,
  observation: HnSnapshotObservation
): void {
  const existing = snapshot.stories[String(item.id)];
  const bestRank = existing ? Math.min(existing.bestRank, observation.rank) : observation.rank;
  const bestRankSource = existing && existing.bestRank <= observation.rank
    ? existing.bestRankSource
    : observation.source;

  snapshot.stories[String(item.id)] = {
    id: item.id,
    firstSeenAt: existing?.firstSeenAt ?? observation.fetchedAt,
    lastSeenAt: observation.fetchedAt,
    appearances: (existing?.appearances ?? 0) + 1,
    bestRank,
    bestRankSource,
    maxScore: Math.max(existing?.maxScore ?? 0, item.score ?? 0),
    maxDescendants: Math.max(existing?.maxDescendants ?? 0, item.descendants ?? 0),
    latest: item,
    observations: [...(existing?.observations ?? []), observation].slice(-120)
  };
}

export async function loadHnDailySnapshot(paths: ProjectPaths, date: string): Promise<HnDailySnapshot> {
  return readJsonFile<HnDailySnapshot>(snapshotPath(paths, date), {
    ...DEFAULT_SNAPSHOT,
    date,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(0).toISOString()
  });
}

export async function saveHnDailySnapshot(paths: ProjectPaths, snapshot: HnDailySnapshot): Promise<void> {
  const filePath = snapshotPath(paths, snapshot.date);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function captureHnSnapshot(config: RunConfig, paths: ProjectPaths): Promise<HnDailySnapshot> {
  const fetchedAt = config.generatedAt;
  const snapshot = await loadHnDailySnapshot(paths, config.targetDate);
  const limit = Math.max(config.hnSnapshotStoryLimit, config.hnDailyStoryLimit);
  const [topIds, bestIds] = await Promise.all([
    fetchStoryIds(HN_TOP_STORIES_ENDPOINT, limit),
    fetchStoryIds(HN_BEST_STORIES_ENDPOINT, limit)
  ]);

  const rankedIds = uniqueRankedIds(topIds, bestIds);
  const items = await Promise.all(rankedIds.map(async (record) => ({
    record,
    item: await fetchItemById(record.id)
  })));

  for (const { record, item } of items) {
    if (!item || item.type !== "story" || item.dead || item.deleted) {
      continue;
    }
    if (record.topRank) {
      observeStory(snapshot, item, {
        fetchedAt,
        source: "topstories",
        rank: record.topRank,
        score: item.score ?? 0,
        descendants: item.descendants ?? 0
      });
    }
    if (record.bestRank) {
      observeStory(snapshot, item, {
        fetchedAt,
        source: "beststories",
        rank: record.bestRank,
        score: item.score ?? 0,
        descendants: item.descendants ?? 0
      });
    }
  }

  snapshot.updatedAt = fetchedAt;
  snapshot.runs = [
    ...snapshot.runs,
    {
      fetchedAt,
      topStoryCount: topIds.length,
      bestStoryCount: bestIds.length
    }
  ].slice(-24);
  await saveHnDailySnapshot(paths, snapshot);
  return snapshot;
}

export async function loadHnSnapshotRankedStories(
  config: RunConfig,
  paths: ProjectPaths
): Promise<HnRankedSnapshotStory[]> {
  const snapshot = await loadHnDailySnapshot(paths, config.targetDate);
  return Object.values(snapshot.stories)
    .map((story) => ({
      id: story.id,
      rank: 0,
      dailyHotScore: dailyHotScore(story),
      bestRank: story.bestRank,
      bestRankSource: story.bestRankSource,
      maxScore: story.maxScore,
      maxDescendants: story.maxDescendants,
      firstSeenAt: story.firstSeenAt,
      lastSeenAt: story.lastSeenAt,
      appearances: story.appearances
    }))
    .sort((a, b) => b.dailyHotScore - a.dailyHotScore)
    .map((story, index) => ({ ...story, rank: index + 1 }));
}
