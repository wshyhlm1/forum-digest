import { sha256 } from "../shared/hash.js";
import type { AppEnv, RunConfig, StoryRecord } from "../shared/types.js";
import {
  computeHotScore,
  createBaseStory,
  createCommentNode,
  isWithinTargetDate,
  pickSummaryParagraphsFromHtml,
  sanitizeForumHtml
} from "./source-utils.js";

const LINUXDO_BASE = "https://linux.do";
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 forum-digest/1.0",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8"
};

interface DiscourseTopicList {
  topic_list?: {
    topics?: DiscourseTopic[];
  };
}

interface DiscourseTopic {
  id?: number;
  title?: string;
  slug?: string;
  created_at?: string;
  last_posted_at?: string;
  bumped_at?: string;
  posts_count?: number;
  reply_count?: number;
  like_count?: number;
  views?: number;
  excerpt?: string;
}

interface DiscourseTopicDetail {
  id?: number;
  title?: string;
  slug?: string;
  created_at?: string;
  posts_count?: number;
  reply_count?: number;
  like_count?: number;
  views?: number;
  post_stream?: {
    posts?: DiscoursePost[];
  };
}

interface DiscoursePost {
  id?: number;
  post_number?: number;
  username?: string;
  name?: string;
  created_at?: string;
  cooked?: string;
  reply_to_post_number?: number | null;
  deleted_at?: string | null;
}

function buildHeaders(env?: AppEnv): Record<string, string> {
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (env?.linuxDoCookie) {
    headers.Cookie = env.linuxDoCookie;
  }
  return headers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJson<T>(url: string, env?: AppEnv): Promise<T> {
  const response = await fetch(url, {
    headers: buildHeaders(env),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`Linux.do fetch failed ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

function buildTopicUrl(topic: Pick<DiscourseTopic, "id" | "slug">): string {
  if (topic.slug) {
    return `${LINUXDO_BASE}/t/${topic.slug}/${topic.id}`;
  }
  return `${LINUXDO_BASE}/t/${topic.id}`;
}

function topicExcerptHtml(topic: DiscourseTopic): string {
  return topic.excerpt ? sanitizeForumHtml(topic.excerpt) : "";
}

function toStory(topic: DiscourseTopic, rank: number, config: RunConfig): StoryRecord | null {
  if (!topic.id || !topic.title || !topic.created_at) {
    return null;
  }

  const textRawHtml = topicExcerptHtml(topic);
  const commentsCount = Number(topic.reply_count ?? Math.max(0, Number(topic.posts_count ?? 1) - 1));
  const score = Number(topic.like_count ?? 0) + Math.round(Number(topic.views ?? 0) / 20);
  const discussionUrl = buildTopicUrl(topic);

  const story = createBaseStory({
    id: topic.id,
    source: "linuxdo",
    rank,
    title: topic.title,
    url: discussionUrl,
    discussionUrl,
    score,
    publishedAt: topic.created_at,
    commentsCount,
    textRawHtml,
    summaryRaw: pickSummaryParagraphsFromHtml(textRawHtml, config.articleSummaryMaxParagraphs),
    category: "Linux.do",
    hotScore: computeHotScore(score, commentsCount, topic.created_at, config.generatedAt),
    generatedAt: config.generatedAt
  });

  return {
    ...story,
    contentHash: sha256(`linuxdo\n${topic.id}\n${topic.title}\n${textRawHtml}`)
  };
}

async function fetchTopicLists(config: RunConfig, env?: AppEnv): Promise<DiscourseTopic[]> {
  const endpoints = [
    `${LINUXDO_BASE}/top.json?period=daily`,
    `${LINUXDO_BASE}/latest.json`
  ];
  const results = await Promise.allSettled(endpoints.map((endpoint) => fetchJson<DiscourseTopicList>(endpoint, env)));
  if (results.every((result) => result.status === "rejected")) {
    const errors = results
      .map((result) => (result.status === "rejected" ? errorMessage(result.reason) : ""))
      .filter(Boolean)
      .join("; ");
    throw new Error(errors || "Linux.do topic list endpoints are unavailable.");
  }

  const topics = results.flatMap((result) => (
    result.status === "fulfilled" ? result.value.topic_list?.topics ?? [] : []
  ));

  const deduped = new Map<number, DiscourseTopic>();
  for (const topic of topics) {
    if (topic.id && !deduped.has(topic.id)) {
      deduped.set(topic.id, topic);
    }
  }

  return [...deduped.values()]
    .filter((topic) => topic.created_at && isWithinTargetDate(topic.created_at, config))
    .sort((a, b) => {
      const aScore = computeHotScore(Number(a.like_count ?? 0), Number(a.reply_count ?? 0), a.created_at ?? config.generatedAt, config.generatedAt);
      const bScore = computeHotScore(Number(b.like_count ?? 0), Number(b.reply_count ?? 0), b.created_at ?? config.generatedAt, config.generatedAt);
      return bScore - aScore;
    })
    .slice(0, config.candidateLimitPerSource);
}

export async function fetchLinuxDoCandidates(config: RunConfig, env?: AppEnv): Promise<StoryRecord[]> {
  const topics = await fetchTopicLists(config, env);

  return topics
    .map((topic, index) => toStory(topic, index + 1, config))
    .filter((story): story is StoryRecord => Boolean(story))
    .map((story, index) => ({
      ...story,
      sourceRank: index + 1,
      rank: index + 1
    }));
}

async function fetchTopicDetail(story: StoryRecord, env?: AppEnv): Promise<DiscourseTopicDetail | null> {
  const detailUrl = `${LINUXDO_BASE}/t/${story.id}.json`;
  return fetchJson<DiscourseTopicDetail>(detailUrl, env).catch(() => null);
}

export async function hydrateLinuxDoStory(story: StoryRecord, maxComments: number, env?: AppEnv): Promise<StoryRecord> {
  const detail = await fetchTopicDetail(story, env);
  const posts = detail?.post_stream?.posts ?? [];
  if (!detail || posts.length === 0) {
    return story;
  }

  const firstPost = posts.find((post) => post.post_number === 1) ?? posts[0];
  const textRawHtml = sanitizeForumHtml(firstPost.cooked ?? story.textRawHtml);
  const comments = posts
    .filter((post) => post.post_number !== firstPost.post_number)
    .slice(0, maxComments)
    .map((post, index) => createCommentNode({
      source: "linuxdo",
      id: post.id ?? `${story.id}-${index + 1}`,
      parentId: story.id,
      author: post.username || post.name,
      publishedAt: post.created_at ?? story.publishedAt,
      level: 1,
      sourceUrl: `${story.discussionUrl}/${post.post_number ?? index + 2}`,
      floor: post.post_number,
      textRawHtml: sanitizeForumHtml(post.cooked ?? ""),
      isDeleted: Boolean(post.deleted_at)
    }));

  return {
    ...story,
    author: firstPost.username || firstPost.name || story.author,
    textRawHtml,
    summaryRaw: pickSummaryParagraphsFromHtml(textRawHtml, 5),
    comments,
    commentsCount: detail.reply_count ?? story.commentsCount,
    score: Number(detail.like_count ?? story.score),
    contentHash: sha256(`linuxdo\n${story.id}\n${story.title}\n${textRawHtml}`)
  };
}
