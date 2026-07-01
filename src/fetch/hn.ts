import { JSDOM, VirtualConsole } from "jsdom";
import sanitizeHtml from "sanitize-html";

import {
  HN_BEST_STORIES_ENDPOINT,
  HN_ITEM_ENDPOINT,
  HN_TOP_STORIES_ENDPOINT
} from "../shared/constants.js";
import { getProjectPaths } from "../shared/config.js";
import { sha256 } from "../shared/hash.js";
import type { CommentNode, HnItemRecord, RunConfig, StoryRecord } from "../shared/types.js";
import { loadHnSnapshotRankedStories, type HnRankedSnapshotStory } from "../snapshot/hn.js";
import {
  buildCommentKey,
  buildStoryKey,
  computeHotScore
} from "./source-utils.js";

const HN_BASE = "https://news.ycombinator.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BEST_LIST_PAGES = 10;
const MAX_CONCURRENT_HN_REQUESTS = 10;
const BEST_LIST_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BEST_LIST_MAX_RETRIES = 2;
const BEST_LIST_RETRY_DELAY_MS = 1_000;

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.permits += 1;
    }
  }
}

class BestListHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Failed to fetch best list: ${status}`);
    this.name = "BestListHttpError";
    this.status = status;
  }
}

const hnApiSemaphore = new Semaphore(MAX_CONCURRENT_HN_REQUESTS);

let snapshotRankingCache: { targetDate: string; stories: HnRankedSnapshotStory[] } | null = null;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "a", "code", "pre", "ul", "ol", "li", "blockquote", "em", "strong", "i", "b", "br"],
  allowedAttributes: {
    a: ["href", "target", "rel"]
  },
  allowedSchemes: ["http", "https", "mailto"]
};

function buildHnUrl(id: number): string {
  return `${HN_BASE}/item?id=${id}`;
}

function toIsoTime(unixSeconds?: number): string {
  if (!unixSeconds) {
    return new Date(0).toISOString();
  }
  return new Date(unixSeconds * 1000).toISOString();
}

function getDomain(url: string): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildCommentUrl(id: number): string {
  return buildHnUrl(id);
}

async function loadSnapshotRanking(config: RunConfig): Promise<HnRankedSnapshotStory[]> {
  if (snapshotRankingCache?.targetDate === config.targetDate) {
    return snapshotRankingCache.stories;
  }
  const stories = await loadHnSnapshotRankedStories(config, getProjectPaths()).catch(() => []);
  snapshotRankingCache = { targetDate: config.targetDate, stories };
  return stories;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchBestListPage(url: string): Promise<string> {
  for (let attempt = 0; attempt <= BEST_LIST_MAX_RETRIES; attempt += 1) {
    const response = await fetchWithTimeout(url);
    if (response.ok) {
      return response.text();
    }

    const shouldRetry = BEST_LIST_RETRYABLE_STATUS.has(response.status) && attempt < BEST_LIST_MAX_RETRIES;
    if (shouldRetry) {
      await sleep(BEST_LIST_RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    throw new BestListHttpError(response.status);
  }

  throw new Error("best list fetch retries exhausted");
}

function isHnBestListUrl(listUrl: string): boolean {
  try {
    const parsed = new URL(listUrl);
    return parsed.hostname === "news.ycombinator.com" && parsed.pathname.startsWith("/best");
  } catch {
    return false;
  }
}

function mergeUniqueIds(primary: number[], fallback: number[], limit: number): number[] {
  const merged: number[] = [];
  const seen = new Set<number>();

  for (const id of [...primary, ...fallback]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(id);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

async function fetchBestStoryIdsFromApi(limit: number): Promise<number[]> {
  return fetchStoryIdsFromOfficialEndpoint(HN_BEST_STORIES_ENDPOINT, limit);
}

async function fetchStoryIdsFromOfficialEndpoint(endpoint: string, limit: number): Promise<number[]> {
  const response = await fetchWithTimeout(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch HN story ids api: ${response.status}`);
  }

  const payload = await response.json().catch(() => [] as unknown);
  if (!Array.isArray(payload)) {
    throw new Error("beststories api returned non-array payload");
  }

  return payload
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .slice(0, limit);
}

export function parseBestStoryIds(html: string, limit: number): number[] {
  const regex = /item\?id=(\d+)/g;
  const result: number[] = [];
  const seen = new Set<number>();
  let matched: RegExpExecArray | null = regex.exec(html);

  while (matched) {
    const id = Number.parseInt(matched[1], 10);
    if (Number.isFinite(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
      if (result.length >= limit) {
        break;
      }
    }
    matched = regex.exec(html);
  }

  return result;
}

export function parseMoreLink(html: string, currentUrl: string): string | null {
  try {
    const dom = new JSDOM(html, { url: currentUrl });
    const moreLink = dom.window.document.querySelector("a.morelink, a[rel='next']");
    if (moreLink instanceof dom.window.HTMLAnchorElement && moreLink.href) {
      return moreLink.href;
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchBestStoryIds(listUrl: string, limit: number): Promise<number[]> {
  const storyIds: number[] = [];
  const seenIds = new Set<number>();
  const visitedPages = new Set<string>();

  let nextPageUrl: string | null = listUrl;
  let pageCount = 0;

  try {
    while (nextPageUrl && storyIds.length < limit && pageCount < MAX_BEST_LIST_PAGES) {
      const currentPageUrl: string = nextPageUrl;
      if (visitedPages.has(currentPageUrl)) {
        break;
      }
      visitedPages.add(currentPageUrl);
      pageCount += 1;

      const html = await fetchBestListPage(currentPageUrl);
      const pageIds = parseBestStoryIds(html, limit);
      for (const id of pageIds) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          storyIds.push(id);
          if (storyIds.length >= limit) {
            break;
          }
        }
      }

      nextPageUrl = storyIds.length >= limit ? null : parseMoreLink(html, currentPageUrl);
    }
  } catch (error) {
    const isExpectedHttpError = error instanceof BestListHttpError;
    if (isExpectedHttpError && isHnBestListUrl(listUrl)) {
      const fallbackIds = await fetchBestStoryIdsFromApi(limit).catch(() => []);
      const merged = mergeUniqueIds(storyIds, fallbackIds, limit);
      if (merged.length > 0) {
        return merged;
      }
    }
    throw error;
  }

  if (storyIds.length < limit && isHnBestListUrl(listUrl)) {
    const fallbackIds = await fetchBestStoryIdsFromApi(limit).catch(() => []);
    const merged = mergeUniqueIds(storyIds, fallbackIds, limit);
    if (merged.length > storyIds.length) {
      return merged;
    }
  }

  return storyIds.slice(0, limit);
}

export async function fetchHnCandidateIds(config: RunConfig): Promise<number[]> {
  const snapshotStories = await loadSnapshotRanking(config);
  if (snapshotStories.length > 0) {
    return snapshotStories.slice(0, config.candidateLimitPerSource).map((story) => story.id);
  }

  const [topIds, bestIds] = await Promise.all([
    fetchBestStoryIdsFromApi(config.candidateLimitPerSource).catch(() => []),
    fetchStoryIdsFromOfficialEndpoint(HN_TOP_STORIES_ENDPOINT, config.candidateLimitPerSource).catch(() => [])
  ]);
  return mergeUniqueIds(bestIds, topIds, config.candidateLimitPerSource);
}

export async function fetchItemById(id: number): Promise<HnItemRecord | null> {
  await hnApiSemaphore.acquire();
  try {
    const response = await fetchWithTimeout(`${HN_ITEM_ENDPOINT}/${id}.json`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as HnItemRecord | null;
    return body;
  } finally {
    hnApiSemaphore.release();
  }
}

export function sanitizeHnHtml(rawHtml?: string): string {
  if (!rawHtml) {
    return "";
  }
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}

function pickSummaryParagraphs(text: string, maxParagraphs: number): string[] {
  const lines = text
    .split(/\n{2,}/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.slice(0, maxParagraphs);
}

export async function extractExternalSummary(url: string, maxParagraphs: number): Promise<string[]> {
  if (!/^https?:\/\//i.test(url)) {
    return [];
  }

  try {
    const response = await fetchWithTimeout(url, 18_000);
    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {
      // Third-party pages often include CSS features jsdom cannot parse.
      // These should not break summary extraction or spam CI logs.
    });
    const dom = new JSDOM(html, {
      url,
      virtualConsole
    });
    const readabilityModule = await import("@mozilla/readability");
    const reader = new readabilityModule.Readability(dom.window.document);
    const article = reader.parse();

    if (article?.textContent) {
      const fromText = pickSummaryParagraphs(article.textContent, maxParagraphs);
      if (fromText.length > 0) {
        return fromText;
      }
    }

    const desc = dom.window.document.querySelector("meta[name='description']")?.getAttribute("content")?.trim();
    return desc ? [desc] : [];
  } catch {
    return [];
  }
}

async function buildCommentNode(
  commentId: number,
  parentId: number,
  level: number,
  remaining: { value: number }
): Promise<CommentNode | null> {
  if (remaining.value <= 0) {
    return null;
  }

  const item = await fetchItemById(commentId);
  if (!item) {
    return null;
  }

  remaining.value -= 1;

  const rawHtml = sanitizeHnHtml(item.text || "");
  const isDeleted = item.deleted || item.dead || item.type !== "comment";
  const textRawHtml = rawHtml || (isDeleted ? "<p>[deleted]</p>" : "");

  const childrenIds = item.kids ?? [];
  const childNodes: CommentNode[] = [];
  for (const childId of childrenIds) {
    if (remaining.value <= 0) {
      break;
    }
    const child = await buildCommentNode(childId, item.id, level + 1, remaining);
    if (child) {
      childNodes.push(child);
    }
  }

  return {
    id: item.id,
    commentKey: buildCommentKey("hackernews", item.id),
    parentId,
    author: item.by ?? "[deleted]",
    publishedAt: toIsoTime(item.time),
    level,
    hnUrl: buildCommentUrl(item.id),
    sourceUrl: buildCommentUrl(item.id),
    textRawHtml,
    textZhHtml: "",
    translationStatus: "raw_only",
    contentHash: sha256(textRawHtml),
    children: childNodes,
    isDeleted
  };
}

export async function buildCommentTree(story: HnItemRecord, maxComments: number = Number.POSITIVE_INFINITY): Promise<CommentNode[]> {
  const childrenIds = story.kids ?? [];
  const remaining = { value: maxComments };
  const tree: CommentNode[] = [];
  for (const commentId of childrenIds) {
    if (remaining.value <= 0) {
      break;
    }
    const node = await buildCommentNode(commentId, story.id, 1, remaining);
    if (node) {
      tree.push(node);
    }
  }
  return tree;
}

export async function buildStoryCandidate(storyId: number, rank: number, config: RunConfig): Promise<StoryRecord | null> {
  const item = await fetchItemById(storyId);
  if (!item || item.type !== "story") {
    return null;
  }
  const snapshotStory = (await loadSnapshotRanking(config)).find((story) => story.id === storyId);

  const textRawHtml = sanitizeHnHtml(item.text || "");
  const url = item.url ?? "";
  const summaryRaw = url ? await extractExternalSummary(url, config.articleSummaryMaxParagraphs) : [];
  const publishedAt = toIsoTime(item.time);
  const commentsCount = snapshotStory?.maxDescendants ?? item.descendants ?? 0;
  const score = snapshotStory?.maxScore ?? item.score ?? 0;

  const story: StoryRecord = {
    id: item.id,
    storyKey: buildStoryKey("hackernews", item.id),
    source: "hackernews",
    sourceLabel: "Hacker News",
    rank,
    sourceRank: rank,
    type: item.type ?? "story",
    title: item.title ?? "(untitled)",
    titleZh: "",
    url,
    domain: getDomain(url),
    hnUrl: buildHnUrl(item.id),
    discussionUrl: buildHnUrl(item.id),
    author: item.by ?? "unknown",
    score,
    publishedAt,
    commentsCount,
    category: "Hacker News",
    relevanceScore: 0,
    relevanceReason: "",
    hotScore: snapshotStory?.dailyHotScore ?? computeHotScore(score, commentsCount, publishedAt, config.generatedAt),
    snapshotBestRank: snapshotStory?.bestRank,
    snapshotBestRankSource: snapshotStory?.bestRankSource,
    snapshotMaxScore: snapshotStory?.maxScore,
    snapshotMaxComments: snapshotStory?.maxDescendants,
    snapshotFirstSeenAt: snapshotStory?.firstSeenAt,
    snapshotLastSeenAt: snapshotStory?.lastSeenAt,
    snapshotAppearances: snapshotStory?.appearances,
    textRawHtml,
    textZhHtml: "",
    summaryRaw,
    summaryZh: [],
    highlightsZh: [],
    translationStatus: "raw_only",
    contentHash: sha256(`${item.title ?? ""}\n${textRawHtml}\n${summaryRaw.join("\n")}`),
    comments: []
  };

  return story;
}

export async function hydrateHnStory(story: StoryRecord, maxComments: number): Promise<StoryRecord> {
  const item = await fetchItemById(story.id);
  if (!item) {
    return story;
  }
  return {
    ...story,
    comments: await buildCommentTree(item, maxComments)
  };
}

export async function buildStoryRecord(storyId: number, rank: number, summaryMaxParagraphs: number): Promise<StoryRecord | null> {
  const generatedAt = new Date().toISOString();
  const config = {
    generatedAt,
    articleSummaryMaxParagraphs: summaryMaxParagraphs,
    maxCommentsPerStory: Number.POSITIVE_INFINITY
  } as RunConfig;
  const candidate = await buildStoryCandidate(storyId, rank, config);
  return candidate ? hydrateHnStory(candidate, Number.POSITIVE_INFINITY) : null;
}
