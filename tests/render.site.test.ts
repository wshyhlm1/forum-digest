import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderSite } from "../src/render/index.js";
import { renderHnPublicDigest } from "../src/render/hn-public.js";
import type { CommentNode, ProjectPaths, RunConfig, StoryRecord } from "../src/shared/types.js";

const tempDirs: string[] = [];

async function createTempPaths(): Promise<ProjectPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forum-render-"));
  tempDirs.push(root);
  return {
    rootDir: root,
    stateDir: path.join(root, "state"),
    distDir: path.join(root, "dist")
  };
}

function buildConfig(): RunConfig {
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
    maxCommentsPerStory: 240,
    hnDailyStoryLimit: 20,
    hnPublicCommentsPerStory: 8,
    hnSnapshotStoryLimit: 120,
    dryRun: false,
    skipPush: false
  };
}

function buildStories(): StoryRecord[] {
  return [
    {
      id: 1001,
      storyKey: "hackernews-1001",
      source: "hackernews",
      sourceLabel: "Hacker News",
      rank: 1,
      sourceRank: 1,
      type: "story",
      title: "Show HN: Cool AI DB",
      titleZh: "Show HN：很酷的 AI 数据库",
      url: "https://example.com/post",
      domain: "example.com",
      hnUrl: "https://news.ycombinator.com/item?id=1001",
      discussionUrl: "https://news.ycombinator.com/item?id=1001",
      author: "alice",
      score: 321,
      publishedAt: "2026-03-22T03:00:00.000Z",
      commentsCount: 2,
      category: "AI",
      relevanceScore: 92,
      relevanceReason: "AI database discussion",
      hotScore: 120,
      textRawHtml: "<p>Original story body</p>",
      textZhHtml: "<p>中文正文</p>",
      summaryRaw: ["One key point", "Another key point"],
      summaryZh: ["第一条要点", "第二条要点"],
      highlightsZh: ["讨论了向量检索", "有不少工程反馈"],
      translationStatus: "translated",
      contentHash: "hash-story",
      comments: [
        {
          id: 2001,
          commentKey: "hackernews-2001",
          parentId: 1001,
          author: "bob",
          publishedAt: "2026-03-22T03:15:00.000Z",
          level: 1,
          hnUrl: "https://news.ycombinator.com/item?id=2001",
          sourceUrl: "https://news.ycombinator.com/item?id=2001",
          floor: 1,
          textRawHtml: "<p>Original comment body</p>",
          textZhHtml: "<p>中文评论正文</p>",
          translationStatus: "translated",
          contentHash: "hash-c1",
          children: [
            {
              id: 2002,
              commentKey: "hackernews-2002",
              parentId: 2001,
              author: "charlie",
              publishedAt: "2026-03-22T03:18:00.000Z",
              level: 2,
              hnUrl: "https://news.ycombinator.com/item?id=2002",
              sourceUrl: "https://news.ycombinator.com/item?id=2002",
              floor: 2,
              textRawHtml: "<p>Nested original comment</p>",
              textZhHtml: "<p>嵌套评论</p>",
              translationStatus: "translated",
              contentHash: "hash-c2",
              children: []
            }
          ]
        }
      ]
    }
  ];
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("renderSite", () => {
  it("generates manifest with source counts and story json urls", async () => {
    const paths = await createTempPaths();
    const config = buildConfig();

    const result = await renderSite(buildStories(), config, paths);
    const manifestPath = path.join(paths.distDir, "batches", config.batchId, "manifest.json");
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as { batchId: string; sourceCounts: { hackernews: number }; stories: Array<{ storyKey: string; storyJsonUrl: string }>; batchUrl: string };

    expect(result.manifest.batchId).toBe(config.batchId);
    expect(manifest.sourceCounts.hackernews).toBe(1);
    expect(manifest.stories[0].storyKey).toBe("hackernews-1001");
    expect(manifest.stories[0].storyJsonUrl).toBe("https://example.github.io/forum-digest/stories/hackernews-1001.json");
    expect(manifest.batchUrl).toBe("https://example.github.io/forum-digest/batches/2026-03-22/");
  });

  it("renders batch and story pages for the forum digest", async () => {
    const paths = await createTempPaths();
    const config = buildConfig();

    await renderSite(buildStories(), config, paths);

    const batchHtml = await readFile(path.join(paths.distDir, "batches", config.batchId, "index.html"), "utf8");
    expect(batchHtml).toContain("AI/科技论坛日报");
    expect(batchHtml).toContain("Show HN：很酷的 AI 数据库");
    expect(batchHtml).toContain("Hacker News");
    expect(batchHtml).toContain("manifest.json");

    const storyHtml = await readFile(path.join(paths.distDir, "stories", "hackernews-1001.html"), "utf8");
    expect(storyHtml).toContain("回复翻译");
    expect(storyHtml).toContain('data-action="toggle-raw"');
    expect(storyHtml).toContain("中文评论正文");
  });

  it("writes full story json and raw comment json", async () => {
    const paths = await createTempPaths();
    const config = buildConfig();

    await renderSite(buildStories(), config, paths);

    const storyJsonRaw = await readFile(path.join(paths.distDir, "stories", "hackernews-1001.json"), "utf8");
    const storyJson = JSON.parse(storyJsonRaw) as StoryRecord;
    expect(storyJson.comments[0].children[0].textZhHtml).toContain("嵌套评论");

    const rawCommentRaw = await readFile(path.join(paths.distDir, "raw", "comments", "hackernews-2001.json"), "utf8");
    const rawComment = JSON.parse(rawCommentRaw) as { html: string };
    expect(rawComment.html).toBe("<p>Original comment body</p>");
  });

  it("writes lightweight HN public json and full comments json", async () => {
    const paths = await createTempPaths();
    const config = buildConfig();

    await renderHnPublicDigest(buildStories(), config, paths);

    const latestRaw = await readFile(path.join(paths.distDir, "hn", "latest.json"), "utf8");
    const latest = JSON.parse(latestRaw) as { stories: Array<{ storyKey: string; comments: unknown[]; fullCommentsUrl: string }> };
    expect(latest.stories[0].storyKey).toBe("hackernews-1001");
    expect(latest.stories[0].comments).toHaveLength(2);
    expect(latest.stories[0].fullCommentsUrl).toBe("https://example.github.io/forum-digest/hn/2026-03-22-full-comments.json");

    const fullRaw = await readFile(path.join(paths.distDir, "hn", "2026-03-22-full-comments.json"), "utf8");
    const full = JSON.parse(fullRaw) as { stories: Array<{ comments: CommentNode[] }> };
    expect(full.stories[0].comments[0].children[0].textZhHtml).toContain("嵌套评论");
  });
});
