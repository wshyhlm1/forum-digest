import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureHnSnapshot, loadHnSnapshotRankedStories } from "../src/snapshot/hn.js";
import type { ProjectPaths, RunConfig } from "../src/shared/types.js";

const tempDirs: string[] = [];

async function createPaths(): Promise<ProjectPaths> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "hn-snapshot-"));
  tempDirs.push(rootDir);
  return {
    rootDir,
    stateDir: path.join(rootDir, "state"),
    distDir: path.join(rootDir, "dist")
  };
}

function createConfig(): RunConfig {
  return {
    mode: "manual",
    timezone: "Asia/Shanghai",
    slot: "manual",
    batchId: "2026-03-22",
    targetDate: "2026-03-22",
    targetStartIso: "2026-03-21T16:00:00.000Z",
    targetEndIso: "2026-03-22T16:00:00.000Z",
    listUrl: "https://news.ycombinator.com/best?h=24",
    limit: 10,
    historyDays: 7,
    siteBaseUrl: "https://example.github.io/forum-digest/",
    articleSummaryMaxParagraphs: 5,
    generatedAt: "2026-03-22T04:00:00.000Z",
    commentTranslationCharBudget: 320000,
    candidateLimitPerSource: 80,
    maxCommentsPerStory: 1000,
    hnDailyStoryLimit: 20,
    hnPublicCommentsPerStory: 8,
    hnSnapshotStoryLimit: 3,
    dryRun: true,
    skipPush: true
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HN snapshot", () => {
  it("captures official top/best story observations and ranks daily stories", async () => {
    const paths = await createPaths();
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/topstories.json")) {
        return new Response(JSON.stringify([101, 102]), { status: 200 });
      }
      if (url.endsWith("/beststories.json")) {
        return new Response(JSON.stringify([102, 103]), { status: 200 });
      }
      const id = Number(url.match(/item\/(\d+)\.json/)?.[1]);
      return new Response(JSON.stringify({
        id,
        type: "story",
        by: `user-${id}`,
        title: `AI story ${id}`,
        score: id === 102 ? 200 : 80,
        descendants: id === 102 ? 40 : 10,
        time: 1711065600,
        kids: []
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);

    await captureHnSnapshot(createConfig(), paths);

    const raw = await readFile(path.join(paths.stateDir, "hn-snapshots", "2026-03-22.json"), "utf8");
    const snapshot = JSON.parse(raw) as { stories: Record<string, { bestRank: number; appearances: number; maxScore: number }> };
    expect(snapshot.stories["102"].bestRank).toBe(1);
    expect(snapshot.stories["102"].appearances).toBe(2);
    expect(snapshot.stories["102"].maxScore).toBe(200);

    const ranked = await loadHnSnapshotRankedStories(createConfig(), paths);
    expect(ranked[0].id).toBe(102);
    expect(ranked[0].maxDescendants).toBe(40);
  });
});
