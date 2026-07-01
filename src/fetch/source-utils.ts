import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";

import { sha256 } from "../shared/hash.js";
import type { CommentNode, RunConfig, StoryRecord, StorySource } from "../shared/types.js";

export const SOURCE_LABELS: Record<StorySource, string> = {
  hackernews: "Hacker News",
  v2ex: "V2EX",
  linuxdo: "Linux.do"
};

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "a", "code", "pre", "ul", "ol", "li", "blockquote", "em", "strong", "i", "b", "br", "span"],
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
};

export function buildStoryKey(source: StorySource, id: number | string): string {
  return `${source}-${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function buildCommentKey(source: StorySource, id: number | string): string {
  return `${source}-${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function sanitizeForumHtml(rawHtml?: string): string {
  if (!rawHtml) {
    return "";
  }
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}

export function plainTextFromHtml(html: string): string {
  if (!html.trim()) {
    return "";
  }
  const dom = new JSDOM(`<body>${html}</body>`);
  return dom.window.document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function pickSummaryParagraphsFromHtml(html: string, maxParagraphs: number): string[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  const paragraphs = Array.from(dom.window.document.querySelectorAll("p, li, blockquote"))
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((item) => item.length >= 12);

  if (paragraphs.length > 0) {
    return paragraphs.slice(0, maxParagraphs);
  }

  const fallback = plainTextFromHtml(html);
  return fallback ? [fallback.slice(0, 360)] : [];
}

export function getDomain(url: string): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function toIsoTimeFromUnix(unixSeconds?: number): string {
  if (!unixSeconds) {
    return new Date(0).toISOString();
  }
  return new Date(unixSeconds * 1000).toISOString();
}

export function isWithinTargetDate(isoDate: string, config: RunConfig): boolean {
  const time = new Date(isoDate).getTime();
  const start = new Date(config.targetStartIso).getTime();
  const end = new Date(config.targetEndIso).getTime();
  return Number.isFinite(time) && time >= start && time < end;
}

export function computeHotScore(score: number, commentsCount: number, publishedAt: string, generatedAt: string): number {
  const ageHours = Math.max(1, (new Date(generatedAt).getTime() - new Date(publishedAt).getTime()) / 3_600_000);
  const engagement = Math.max(0, score) * 2 + Math.max(0, commentsCount) * 3;
  return Math.round((engagement / Math.sqrt(ageHours)) * 100) / 100;
}

export function createBaseStory(input: {
  id: number;
  source: StorySource;
  rank?: number;
  type?: string;
  title: string;
  url?: string;
  discussionUrl: string;
  author?: string;
  score?: number;
  publishedAt: string;
  commentsCount?: number;
  textRawHtml?: string;
  summaryRaw?: string[];
  category?: string;
  hotScore?: number;
  generatedAt: string;
}): StoryRecord {
  const sourceLabel = SOURCE_LABELS[input.source];
  const textRawHtml = sanitizeForumHtml(input.textRawHtml ?? "");
  const summaryRaw = input.summaryRaw ?? pickSummaryParagraphsFromHtml(textRawHtml, 5);
  const url = input.url ?? input.discussionUrl;
  return {
    id: input.id,
    storyKey: buildStoryKey(input.source, input.id),
    source: input.source,
    sourceLabel,
    rank: input.rank ?? 0,
    sourceRank: input.rank ?? 0,
    type: input.type ?? "story",
    title: input.title || "(untitled)",
    titleZh: "",
    url,
    domain: getDomain(url || input.discussionUrl),
    hnUrl: input.discussionUrl,
    discussionUrl: input.discussionUrl,
    author: input.author ?? "unknown",
    score: input.score ?? 0,
    publishedAt: input.publishedAt,
    commentsCount: input.commentsCount ?? 0,
    category: input.category ?? "",
    relevanceScore: 0,
    relevanceReason: "",
    hotScore: input.hotScore ?? computeHotScore(input.score ?? 0, input.commentsCount ?? 0, input.publishedAt, input.generatedAt),
    textRawHtml,
    textZhHtml: "",
    summaryRaw,
    summaryZh: [],
    highlightsZh: [],
    translationStatus: "raw_only",
    contentHash: sha256(`${input.source}\n${input.id}\n${input.title}\n${textRawHtml}\n${summaryRaw.join("\n")}`),
    comments: []
  };
}

export function createCommentNode(input: {
  source: StorySource;
  id: number | string;
  parentId: number | string;
  author?: string;
  publishedAt: string;
  level?: number;
  sourceUrl: string;
  floor?: number;
  textRawHtml?: string;
  children?: CommentNode[];
  isDeleted?: boolean;
}): CommentNode {
  const textRawHtml = sanitizeForumHtml(input.textRawHtml ?? "");
  return {
    id: input.id,
    commentKey: buildCommentKey(input.source, input.id),
    parentId: input.parentId,
    author: input.author ?? "unknown",
    publishedAt: input.publishedAt,
    level: input.level ?? 1,
    hnUrl: input.sourceUrl,
    sourceUrl: input.sourceUrl,
    floor: input.floor,
    textRawHtml,
    textZhHtml: "",
    translationStatus: "raw_only",
    contentHash: sha256(textRawHtml),
    children: input.children ?? [],
    isDeleted: input.isDeleted
  };
}
