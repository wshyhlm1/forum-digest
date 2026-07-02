import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sanitizeHtml from "sanitize-html";

import type {
  BatchManifest,
  BatchManifestStory,
  CommentNode,
  ProjectPaths,
  RunConfig,
  SourceStatusMap,
  StoryRecord,
  StorySource
} from "../shared/types.js";
import { plainTextFromHtml } from "../fetch/source-utils.js";

export interface RenderResult {
  manifest: BatchManifest;
}

const BASE_ALLOWED_TAGS = ["p", "a", "code", "pre", "ul", "ol", "li", "blockquote", "strong", "em", "b", "i", "br", "span"];
const SOURCE_ORDER: StorySource[] = ["hackernews", "v2ex", "linuxdo"];

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function formatChinaTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function relativeAge(value: string, nowIso: string): string {
  const now = new Date(nowIso).getTime();
  const then = new Date(value).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(then)) {
    return "-";
  }
  const diffMinutes = Math.max(1, Math.floor((now - then) / 60000));
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }
  return `${Math.floor(diffHours / 24)} 天前`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeRichHtml(value: string): string {
  return sanitizeHtml(value || "", {
    allowedTags: BASE_ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "target", "rel"],
      span: ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          href: attribs.href || "#",
          target: "_blank",
          rel: "noopener noreferrer"
        }
      })
    }
  });
}

function flattenComments(tree: CommentNode[]): CommentNode[] {
  const out: CommentNode[] = [];
  const queue = [...tree];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    out.push(node);
    queue.push(...node.children);
  }
  return out;
}

function countBySource(stories: StoryRecord[]): Record<StorySource, number> {
  return {
    hackernews: stories.filter((story) => story.source === "hackernews").length,
    v2ex: stories.filter((story) => story.source === "v2ex").length,
    linuxdo: stories.filter((story) => story.source === "linuxdo").length
  };
}

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

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const boundary = Math.max(
    normalized.lastIndexOf("。", maxLength),
    normalized.lastIndexOf("！", maxLength),
    normalized.lastIndexOf("？", maxLength),
    normalized.lastIndexOf(".", maxLength),
    normalized.lastIndexOf(";", maxLength),
    normalized.lastIndexOf(" ", maxLength)
  );
  const cutAt = boundary >= 100 ? boundary + 1 : maxLength;
  return `${normalized.slice(0, cutAt).trim()}...`;
}

function buildSummaryZhShort(story: StoryRecord): string {
  const candidate = normalizeText([
    ...story.summaryZh,
    ...story.highlightsZh
  ].filter(Boolean).join(" "));

  if (candidate) {
    return truncateText(candidate, 220);
  }

  const bodyText = normalizeText(
    plainTextFromHtml(story.textZhHtml || story.textRawHtml || "")
  );
  if (bodyText) {
    return truncateText(bodyText, 220);
  }

  return "";
}

function buildSourceStatus(
  stories: StoryRecord[],
  config: RunConfig,
  sourceStatus?: SourceStatusMap
): SourceStatusMap {
  const counts = countBySource(stories);
  return SOURCE_ORDER.reduce((status, source) => {
    const current = sourceStatus?.[source];
    status[source] = {
      ok: current?.ok ?? true,
      count: counts[source],
      ...(current?.error ? { error: current.error } : {}),
      attemptedAt: current?.attemptedAt ?? config.generatedAt
    };
    return status;
  }, {} as SourceStatusMap);
}

function renderList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderCommentNode(node: CommentNode): string {
  const safeZh = sanitizeRichHtml(node.textZhHtml || node.textRawHtml || "<p>暂无内容</p>");
  const safeRaw = sanitizeRichHtml(node.textRawHtml || "<p>暂无原文</p>");
  const deletedBadge = node.isDeleted ? `<span class="badge">deleted</span>` : "";
  const floor = node.floor ? `<span>#${node.floor}</span>` : "";
  const children = node.children.map((item) => renderCommentNode(item)).join("");
  const indentClass = `depth-${Math.min(node.level, 4)}`;

  return `
    <details class="comment-node ${indentClass}">
      <summary>
        <span class="meta-author">${escapeHtml(node.author || "unknown")}</span>
        ${floor}
        <span>${escapeHtml(formatChinaTime(node.publishedAt))}</span>
        ${deletedBadge}
      </summary>
      <div class="comment-body">
        <div class="comment-text" data-role="comment-zh">${safeZh}</div>
        <div class="comment-text is-hidden" data-role="comment-raw" data-comment-key="${escapeHtml(node.commentKey)}">${safeRaw}</div>
        <div class="actions">
          <button type="button" class="btn secondary" data-action="toggle-raw" data-comment-key="${escapeHtml(node.commentKey)}">原文</button>
          <button type="button" class="btn secondary" data-action="toggle-expand">展开</button>
          <a class="btn secondary" href="${escapeHtml(node.sourceUrl)}" target="_blank" rel="noopener noreferrer">楼层</a>
        </div>
        ${children ? `<div class="comment-children">${children}</div>` : ""}
      </div>
    </details>
  `;
}

function renderStoryPage(story: StoryRecord, config: RunConfig): string {
  const sourceUrlButton = story.url && story.url !== story.discussionUrl
    ? `<a class="btn" href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">打开外部链接</a>`
    : "";
  const commentTreeHtml = story.comments.map((node) => renderCommentNode(node)).join("");
  const rawCommentCount = flattenComments(story.comments).length;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(story.titleZh || story.title)} | AI/科技论坛日报</title>
  <style>${buildStyle()}</style>
</head>
<body data-page="story">
  <main class="page story-page">
    <header class="topbar">
      <a class="back-link" href="${escapeHtml(new URL(`batches/${config.batchId}/`, ensureTrailingSlash(config.siteBaseUrl)).toString())}">返回日报</a>
      <div class="source-chip">${escapeHtml(story.sourceLabel)} #${story.sourceRank}</div>
      <h1>${escapeHtml(story.titleZh || story.title)}</h1>
      <p class="original-title">${escapeHtml(story.title)}</p>
      <div class="meta-line">
        <span>${escapeHtml(story.category || "科技")}</span>
        <span>作者 ${escapeHtml(story.author || "-")}</span>
        <span>热度 ${story.score}</span>
        <span>回复 ${story.commentsCount}</span>
        <span>${escapeHtml(formatChinaTime(story.publishedAt))}</span>
      </div>
      <div class="actions">
        <a class="btn" href="${escapeHtml(story.discussionUrl)}" target="_blank" rel="noopener noreferrer">打开原帖</a>
        ${sourceUrlButton}
        <a class="btn secondary" href="${escapeHtml(new URL(`stories/${story.storyKey}.json`, ensureTrailingSlash(config.siteBaseUrl)).toString())}">JSON</a>
      </div>
    </header>

    <section class="section">
      <h2>摘要</h2>
      ${renderList(story.summaryZh, "暂无摘要")}
      ${story.highlightsZh.length ? `<h3>看点</h3>${renderList(story.highlightsZh, "")}` : ""}
      ${story.relevanceReason ? `<p class="reason">${escapeHtml(story.relevanceReason)}</p>` : ""}
    </section>

    <section class="section">
      <h2>正文翻译</h2>
      <div class="post-body" data-role="story-zh">${sanitizeRichHtml(story.textZhHtml || story.textRawHtml || "<p>暂无正文</p>")}</div>
      <div class="post-body is-hidden" data-role="story-raw">${sanitizeRichHtml(story.textRawHtml || "<p>暂无原文</p>")}</div>
      <button type="button" class="btn secondary" data-action="toggle-story-raw">原文</button>
    </section>

    <section class="section comments">
      <h2>回复翻译 <span class="count">${rawCommentCount}</span></h2>
      <div class="comment-tree">
        ${commentTreeHtml || `<p class="muted">暂无公开回复</p>`}
      </div>
    </section>
  </main>
  <script>
    ${buildScript()}
  </script>
</body>
</html>`;
}

function renderStoryCard(story: StoryRecord, config: RunConfig): string {
  const storyUrl = new URL(`stories/${story.storyKey}.html`, ensureTrailingSlash(config.siteBaseUrl)).toString();
  const summaryPreview = story.summaryZh[0] ? `<p class="summary-preview">${escapeHtml(story.summaryZh[0])}</p>` : "";
  return `
    <article class="story-card">
      <div class="rank">#${story.sourceRank}</div>
      <div class="story-main">
        <div class="card-kicker">
          <span>${escapeHtml(story.category || "科技")}</span>
          <span>${story.score} 热度</span>
          <span>${story.commentsCount} 回复</span>
        </div>
        <h3><a href="${escapeHtml(storyUrl)}">${escapeHtml(story.titleZh || story.title)}</a></h3>
        <p class="original-title">${escapeHtml(story.title)}</p>
        ${summaryPreview}
        <div class="meta-line">
          <span>${escapeHtml(story.author || "-")}</span>
          <span>${escapeHtml(relativeAge(story.publishedAt, config.generatedAt))}</span>
          <span>${escapeHtml(story.domain || story.sourceLabel)}</span>
        </div>
        ${story.highlightsZh.length ? `<div class="compact-list">${renderList(story.highlightsZh.slice(0, 3), "")}</div>` : ""}
        <div class="actions">
          <a class="btn" href="${escapeHtml(storyUrl)}">详情</a>
          <a class="btn secondary" href="${escapeHtml(story.discussionUrl)}" target="_blank" rel="noopener noreferrer">原帖</a>
        </div>
      </div>
    </article>
  `;
}

function renderBatchListPage(stories: StoryRecord[], config: RunConfig): string {
  const counts = countBySource(stories);
  const groups = SOURCE_ORDER.map((source) => {
    const sourceStories = stories.filter((story) => story.source === source);
    const label = sourceStories[0]?.sourceLabel ?? (source === "hackernews" ? "Hacker News" : source === "v2ex" ? "V2EX" : "Linux.do");
    return `
      <section class="source-section">
        <header class="source-header">
          <h2>${escapeHtml(label)}</h2>
          <span>${sourceStories.length} 条</span>
        </header>
        <div class="story-list">
          ${sourceStories.length ? sourceStories.map((story) => renderStoryCard(story, config)).join("") : `<p class="muted empty-source">当天没有筛到公开可读的 AI/科技相关帖子。</p>`}
        </div>
      </section>
    `;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI/科技论坛日报 ${escapeHtml(config.targetDate)}</title>
  <style>${buildStyle()}</style>
</head>
<body data-page="batch">
  <main class="page">
    <header class="topbar">
      <h1>AI/科技论坛日报</h1>
      <p class="subtitle">目标日期 ${escapeHtml(config.targetDate)}，北京时间 ${escapeHtml(formatChinaTime(config.generatedAt))} 生成。</p>
      <div class="meta-line">
        <span>Hacker News ${counts.hackernews}</span>
        <span>V2EX ${counts.v2ex}</span>
        <span>Linux.do ${counts.linuxdo}</span>
        <span>每源目标 ${config.limit} 条</span>
      </div>
      <div class="actions">
        <a class="btn" href="${escapeHtml(new URL(`batches/${config.batchId}/manifest.json`, ensureTrailingSlash(config.siteBaseUrl)).toString())}">manifest.json</a>
      </div>
    </header>
    ${groups}
  </main>
</body>
</html>`;
}

function renderRootIndex(config: RunConfig): string {
  const batchUrl = new URL(`batches/${config.batchId}/`, ensureTrailingSlash(config.siteBaseUrl)).toString();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(batchUrl)}">
  <title>AI/科技论坛日报</title>
  <style>${buildStyle()}</style>
</head>
<body>
  <main class="page redirect-page">
    <h1>正在打开最新日报</h1>
    <a class="btn" href="${escapeHtml(batchUrl)}">${escapeHtml(batchUrl)}</a>
  </main>
</body>
</html>`;
}

function buildStyle(): string {
  return `
  :root {
    --bg: #f6f7f4;
    --paper: #ffffff;
    --ink: #202124;
    --muted: #687076;
    --line: #d9ded8;
    --accent: #c24f18;
    --accent-soft: #fff1e8;
    --blue: #255f85;
    --green: #276749;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    line-height: 1.62;
  }
  .page {
    width: min(980px, 100%);
    margin: 0 auto;
    padding: 18px 14px 72px;
  }
  .topbar, .section {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 14px;
  }
  .topbar h1 {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.25;
  }
  .subtitle, .original-title, .muted, .reason {
    color: var(--muted);
  }
  .subtitle, .original-title {
    margin: 6px 0 0;
  }
  .source-chip {
    display: inline-block;
    margin-bottom: 8px;
    color: var(--blue);
    font-weight: 700;
  }
  .meta-line, .card-kicker {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-top: 8px;
    color: var(--muted);
    font-size: 0.88rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .btn {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    padding: 7px 11px;
    font-size: 0.9rem;
    text-decoration: none;
    cursor: pointer;
    line-height: 1.2;
  }
  .btn.secondary {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .back-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .source-section {
    margin-top: 18px;
  }
  .source-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
    border-bottom: 2px solid var(--line);
  }
  .source-header h2, .section h2 {
    margin: 0 0 8px;
    font-size: 1.08rem;
  }
  .section h3 {
    margin: 14px 0 6px;
    font-size: 1rem;
  }
  .story-list {
    display: grid;
    gap: 10px;
  }
  .story-card {
    display: grid;
    grid-template-columns: 46px 1fr;
    gap: 10px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 14px;
  }
  .rank {
    color: var(--green);
    font-weight: 700;
  }
  .story-card h3 {
    margin: 4px 0 0;
    font-size: 1.04rem;
    line-height: 1.35;
  }
  .story-card h3 a {
    color: var(--ink);
    text-decoration: none;
  }
  .story-card h3 a:hover {
    text-decoration: underline;
  }
  .summary-preview {
    margin: 8px 0 0;
  }
  .compact-list ul, .section ul {
    margin: 8px 0 0;
    padding-left: 20px;
  }
  .compact-list li + li, .section li + li {
    margin-top: 4px;
  }
  .post-body, .comment-text {
    overflow-wrap: anywhere;
  }
  .post-body code, .comment-text code {
    background: #eef1ef;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .post-body pre, .comment-text pre {
    overflow-x: auto;
    padding: 10px;
    border-radius: 6px;
    background: #202124;
    color: #f6f7f4;
  }
  .comment-tree {
    display: grid;
    gap: 8px;
  }
  .comment-node {
    border-left: 2px solid var(--line);
    padding-left: 10px;
  }
  .comment-node.depth-2 { border-left-color: #adc7ba; }
  .comment-node.depth-3, .comment-node.depth-4 { border-left-color: #95afc0; }
  .comment-node > summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.88rem;
  }
  .comment-body {
    padding: 8px 0 4px;
  }
  .comment-children {
    display: grid;
    gap: 8px;
    margin-top: 8px;
  }
  .badge, .count {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 7px;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .empty-source {
    background: var(--paper);
    border: 1px dashed var(--line);
    border-radius: 8px;
    padding: 12px;
  }
  .is-hidden { display: none; }
  .redirect-page {
    min-height: 65vh;
    display: grid;
    place-content: center;
    gap: 10px;
    text-align: center;
  }
  @media (max-width: 640px) {
    .story-card {
      grid-template-columns: 1fr;
    }
    .rank {
      margin-bottom: -4px;
    }
  }
  `;
}

function buildScript(): string {
  return `
  (() => {
    function togglePair(primary, secondary, button, primaryLabel, secondaryLabel) {
      const showSecondary = secondary.classList.contains("is-hidden");
      primary.classList.toggle("is-hidden", showSecondary);
      secondary.classList.toggle("is-hidden", !showSecondary);
      button.textContent = showSecondary ? primaryLabel : secondaryLabel;
    }

    document.querySelectorAll('[data-action="toggle-raw"]').forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".comment-body");
        const zh = card?.querySelector('[data-role="comment-zh"]');
        const raw = card?.querySelector('[data-role="comment-raw"]');
        if (zh && raw) {
          togglePair(zh, raw, button, "译文", "原文");
        }
      });
    });

    document.querySelectorAll('[data-action="toggle-expand"]').forEach((button) => {
      button.addEventListener("click", () => {
        const details = button.closest("details");
        if (details) {
          details.open = !details.open;
          button.textContent = details.open ? "收起" : "展开";
        }
      });
    });

    document.querySelectorAll('[data-action="toggle-story-raw"]').forEach((button) => {
      button.addEventListener("click", () => {
        const zh = document.querySelector('[data-role="story-zh"]');
        const raw = document.querySelector('[data-role="story-raw"]');
        if (zh && raw) {
          togglePair(zh, raw, button, "译文", "原文");
        }
      });
    });
  })();
  `;
}

interface RawStoryData {
  storyKey: string;
  textRawHtml: string;
  comments: Array<{ id: number | string; commentKey: string; textRawHtml: string }>;
}

export async function renderSite(
  stories: StoryRecord[],
  config: RunConfig,
  paths: ProjectPaths,
  sourceStatus?: SourceStatusMap
): Promise<RenderResult> {
  const baseUrl = ensureTrailingSlash(config.siteBaseUrl);
  const batchUrl = new URL(`batches/${config.batchId}/`, baseUrl).toString();
  const sourceCounts = countBySource(stories);
  const sourceStatusForManifest = buildSourceStatus(stories, config, sourceStatus);

  const manifestStories: BatchManifestStory[] = stories.map((story) => {
    const digestUrl = new URL(`stories/${story.storyKey}.html`, baseUrl).toString();
    return {
      id: story.id,
      storyKey: story.storyKey,
      source: story.source,
      dailyBriefSourceId: dailyBriefSourceId(story.source),
      sourceLabel: story.sourceLabel,
      rank: story.rank,
      sourceRank: story.sourceRank,
      title: story.title,
      titleZh: story.titleZh,
      digestUrl,
      storyUrl: digestUrl,
      storyJsonUrl: new URL(`stories/${story.storyKey}.json`, baseUrl).toString(),
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
    };
  });

  const manifest: BatchManifest = {
    schemaVersion: 1,
    batchId: config.batchId,
    timezone: config.timezone,
    slot: config.slot,
    generatedAt: config.generatedAt,
    targetDate: config.targetDate,
    storyCount: stories.length,
    sourceCounts,
    sourceStatus: sourceStatusForManifest,
    latestIndexUrl: baseUrl,
    batchUrl,
    stories: manifestStories,
    push: {
      status: "pending",
      messageUrl: batchUrl
    }
  };

  const batchDir = path.join(paths.distDir, "batches", config.batchId);
  const latestBatchDir = path.join(paths.distDir, "batches", "latest");
  const storiesDir = path.join(paths.distDir, "stories");
  const rawDir = path.join(paths.distDir, "raw");
  const rawCommentsDir = path.join(rawDir, "comments");
  await Promise.all([
    mkdir(paths.distDir, { recursive: true }),
    mkdir(batchDir, { recursive: true }),
    mkdir(latestBatchDir, { recursive: true }),
    mkdir(storiesDir, { recursive: true }),
    mkdir(rawDir, { recursive: true }),
    mkdir(rawCommentsDir, { recursive: true })
  ]);

  const rawWrites: Promise<void>[] = [];

  await Promise.all(
    stories.map(async (story) => {
      const rawStory: RawStoryData = {
        storyKey: story.storyKey,
        textRawHtml: story.textRawHtml,
        comments: flattenComments(story.comments).map((comment) => ({
          id: comment.id,
          commentKey: comment.commentKey,
          textRawHtml: comment.textRawHtml
        }))
      };

      rawWrites.push(
        writeFile(path.join(rawDir, `${story.storyKey}.json`), JSON.stringify(rawStory, null, 2), "utf8"),
        writeFile(path.join(storiesDir, `${story.storyKey}.json`), `${JSON.stringify(story, null, 2)}\n`, "utf8")
      );

      for (const comment of rawStory.comments) {
        rawWrites.push(
          writeFile(path.join(rawCommentsDir, `${comment.commentKey}.json`), JSON.stringify({ html: comment.textRawHtml }), "utf8")
        );
      }

      return writeFile(path.join(storiesDir, `${story.storyKey}.html`), renderStoryPage(story, config), "utf8");
    })
  );

  await Promise.all([
    writeFile(path.join(paths.distDir, "index.html"), renderRootIndex(config), "utf8"),
    writeFile(path.join(paths.distDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(path.join(batchDir, "index.html"), renderBatchListPage(stories, config), "utf8"),
    writeFile(path.join(batchDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(path.join(latestBatchDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    ...rawWrites
  ]);

  return { manifest };
}
