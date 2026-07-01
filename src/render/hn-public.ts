import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommentNode, ProjectPaths, RunConfig, StoryRecord } from "../shared/types.js";

interface PublicHnComment {
  id: number | string;
  author: string;
  publishedAt: string;
  url: string;
  floor?: number;
  textZhHtml: string;
}

interface PublicHnStory {
  id: number;
  storyKey: string;
  rank: number;
  title: string;
  titleZh: string;
  url: string;
  hnUrl: string;
  author: string;
  publishedAt: string;
  score: number;
  commentsCount: number;
  bestRank?: number;
  bestRankSource?: string;
  maxScore?: number;
  maxComments?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  appearances?: number;
  category: string;
  summaryZh: string[];
  highlightsZh: string[];
  comments: PublicHnComment[];
  detailUrl: string;
  fullCommentsUrl: string;
}

interface PublicHnDigest {
  version: 1;
  source: "hackernews";
  date: string;
  timezone: string;
  generatedAt: string;
  storyCount: number;
  commentsPerStory: number;
  stories: PublicHnStory[];
}

interface PublicHnFullComments {
  version: 1;
  source: "hackernews";
  date: string;
  timezone: string;
  generatedAt: string;
  stories: Array<{
    id: number;
    storyKey: string;
    title: string;
    titleZh: string;
    hnUrl: string;
    comments: CommentNode[];
  }>;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function flattenComments(tree: CommentNode[]): CommentNode[] {
  const out: CommentNode[] = [];
  const visit = (nodes: CommentNode[]) => {
    for (const node of nodes) {
      out.push(node);
      visit(node.children);
    }
  };
  visit(tree);
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildPublicStory(story: StoryRecord, config: RunConfig): PublicHnStory {
  const baseUrl = ensureTrailingSlash(config.siteBaseUrl);
  const comments = flattenComments(story.comments)
    .filter((comment) => !comment.isDeleted && (comment.textZhHtml || comment.textRawHtml).trim())
    .slice(0, config.hnPublicCommentsPerStory)
    .map((comment) => ({
      id: comment.id,
      author: comment.author,
      publishedAt: comment.publishedAt,
      url: comment.sourceUrl,
      floor: comment.floor,
      textZhHtml: comment.textZhHtml || comment.textRawHtml
    }));

  return {
    id: story.id,
    storyKey: story.storyKey,
    rank: story.sourceRank,
    title: story.title,
    titleZh: story.titleZh,
    url: story.url,
    hnUrl: story.discussionUrl,
    author: story.author,
    publishedAt: story.publishedAt,
    score: story.score,
    commentsCount: story.commentsCount,
    bestRank: story.snapshotBestRank,
    bestRankSource: story.snapshotBestRankSource,
    maxScore: story.snapshotMaxScore,
    maxComments: story.snapshotMaxComments,
    firstSeenAt: story.snapshotFirstSeenAt,
    lastSeenAt: story.snapshotLastSeenAt,
    appearances: story.snapshotAppearances,
    category: story.category,
    summaryZh: story.summaryZh,
    highlightsZh: story.highlightsZh,
    comments,
    detailUrl: new URL(`stories/${story.storyKey}.html`, baseUrl).toString(),
    fullCommentsUrl: new URL(`hn/${config.targetDate}-full-comments.json`, baseUrl).toString()
  };
}

function buildDigest(stories: StoryRecord[], config: RunConfig): PublicHnDigest {
  const hnStories = stories
    .filter((story) => story.source === "hackernews")
    .sort((a, b) => a.sourceRank - b.sourceRank)
    .slice(0, config.hnDailyStoryLimit);

  return {
    version: 1,
    source: "hackernews",
    date: config.targetDate,
    timezone: config.timezone,
    generatedAt: config.generatedAt,
    storyCount: hnStories.length,
    commentsPerStory: config.hnPublicCommentsPerStory,
    stories: hnStories.map((story) => buildPublicStory(story, config))
  };
}

function buildFullComments(stories: StoryRecord[], config: RunConfig): PublicHnFullComments {
  const hnStories = stories
    .filter((story) => story.source === "hackernews")
    .sort((a, b) => a.sourceRank - b.sourceRank)
    .slice(0, config.hnDailyStoryLimit);

  return {
    version: 1,
    source: "hackernews",
    date: config.targetDate,
    timezone: config.timezone,
    generatedAt: config.generatedAt,
    stories: hnStories.map((story) => ({
      id: story.id,
      storyKey: story.storyKey,
      title: story.title,
      titleZh: story.titleZh,
      hnUrl: story.discussionUrl,
      comments: story.comments
    }))
  };
}

function renderHtml(digest: PublicHnDigest): string {
  const cards = digest.stories.map((story) => `
    <article class="card">
      <div class="rank">#${story.rank}</div>
      <div>
        <h2><a href="${escapeHtml(story.detailUrl)}">${escapeHtml(story.titleZh || story.title)}</a></h2>
        <p class="original">${escapeHtml(story.title)}</p>
        <div class="meta">
          <span>${story.score} 分</span>
          <span>${story.commentsCount} 评论</span>
          ${story.bestRank ? `<span>最高 #${story.bestRank}</span>` : ""}
          ${story.appearances ? `<span>${story.appearances} 次快照出现</span>` : ""}
        </div>
        ${story.summaryZh.length ? `<ul>${story.summaryZh.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
        <div class="actions">
          <a href="${escapeHtml(story.hnUrl)}">HN 原帖</a>
          <a href="${escapeHtml(story.fullCommentsUrl)}">完整评论 JSON</a>
        </div>
      </div>
    </article>
  `).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hacker News 日报 ${escapeHtml(digest.date)}</title>
  <style>
    body { margin: 0; background: #f6f7f4; color: #202124; font-family: "Noto Sans SC", "PingFang SC", Arial, sans-serif; line-height: 1.62; }
    main { width: min(920px, 100%); margin: 0 auto; padding: 18px 14px 64px; }
    header, .card { background: #fff; border: 1px solid #d9ded8; border-radius: 8px; padding: 16px; }
    header { margin-bottom: 14px; }
    h1 { margin: 0; font-size: 1.5rem; }
    h2 { margin: 0; font-size: 1.05rem; }
    a { color: #c24f18; text-decoration: none; }
    .card { display: grid; grid-template-columns: 46px 1fr; gap: 10px; margin-bottom: 10px; }
    .rank { font-weight: 700; color: #276749; }
    .original, .meta { color: #687076; }
    .meta, .actions { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: .9rem; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Hacker News 日报</h1>
      <p class="original">日期 ${escapeHtml(digest.date)}，轻量 JSON 保留每篇前 ${digest.commentsPerStory} 条高位评论。</p>
    </header>
    ${cards || "<p>暂无 HN 内容。</p>"}
  </main>
</body>
</html>`;
}

export async function renderHnPublicDigest(
  stories: StoryRecord[],
  config: RunConfig,
  paths: ProjectPaths
): Promise<void> {
  const digest = buildDigest(stories, config);
  const fullComments = buildFullComments(stories, config);
  const hnDir = path.join(paths.distDir, "hn");
  await mkdir(hnDir, { recursive: true });

  await Promise.all([
    writeFile(path.join(hnDir, "latest.json"), `${JSON.stringify(digest, null, 2)}\n`, "utf8"),
    writeFile(path.join(hnDir, `${config.targetDate}.json`), `${JSON.stringify(digest, null, 2)}\n`, "utf8"),
    writeFile(path.join(hnDir, `${config.targetDate}.html`), renderHtml(digest), "utf8"),
    writeFile(path.join(hnDir, `${config.targetDate}-full-comments.json`), `${JSON.stringify(fullComments, null, 2)}\n`, "utf8")
  ]);
}
