import { sha256 } from "../shared/hash.js";
import type { RunConfig, StoryRecord } from "../shared/types.js";
import {
  computeHotScore,
  createBaseStory,
  createCommentNode,
  isWithinTargetDate,
  pickSummaryParagraphsFromHtml,
  sanitizeForumHtml,
  toIsoTimeFromUnix
} from "./source-utils.js";

const V2EX_BASE = "https://www.v2ex.com";
const V2EX_HOT_ENDPOINT = `${V2EX_BASE}/api/topics/hot.json`;
const V2EX_LATEST_ENDPOINT = `${V2EX_BASE}/api/topics/latest.json`;
const V2EX_REPLIES_ENDPOINT = `${V2EX_BASE}/api/replies/show.json`;

interface V2exTopic {
  id?: number;
  title?: string;
  url?: string;
  content?: string;
  content_rendered?: string;
  created?: number;
  replies?: number;
  last_touched?: number;
  node?: {
    name?: string;
    title?: string;
    title_alternative?: string;
  };
  member?: {
    username?: string;
  };
}

interface V2exReply {
  id?: number;
  content?: string;
  content_rendered?: string;
  created?: number;
  member?: {
    username?: string;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "forum-digest/1.0 (+https://github.com)",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`V2EX fetch failed ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

function topicUrl(topic: V2exTopic): string {
  if (topic.url) {
    return topic.url;
  }
  return `${V2EX_BASE}/t/${topic.id}`;
}

function topicHtml(topic: V2exTopic): string {
  if (topic.content_rendered) {
    return sanitizeForumHtml(topic.content_rendered);
  }
  const content = topic.content ?? "";
  return sanitizeForumHtml(
    content
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph}</p>`)
      .join("")
  );
}

function toStory(topic: V2exTopic, rank: number, config: RunConfig): StoryRecord | null {
  if (!topic.id || !topic.title || !topic.created) {
    return null;
  }

  const textRawHtml = topicHtml(topic);
  const publishedAt = toIsoTimeFromUnix(topic.created);
  const commentsCount = Number(topic.replies ?? 0);
  const category = topic.node?.title || topic.node?.title_alternative || topic.node?.name || "V2EX";
  const discussionUrl = topicUrl(topic);
  const score = commentsCount;

  const story = createBaseStory({
    id: topic.id,
    source: "v2ex",
    rank,
    title: topic.title,
    url: discussionUrl,
    discussionUrl,
    author: topic.member?.username,
    score,
    publishedAt,
    commentsCount,
    textRawHtml,
    summaryRaw: pickSummaryParagraphsFromHtml(textRawHtml, config.articleSummaryMaxParagraphs),
    category,
    hotScore: computeHotScore(score, commentsCount, publishedAt, config.generatedAt),
    generatedAt: config.generatedAt
  });

  return {
    ...story,
    contentHash: sha256(`v2ex\n${topic.id}\n${topic.title}\n${textRawHtml}`)
  };
}

export async function fetchV2exCandidates(config: RunConfig): Promise<StoryRecord[]> {
  const [hotResult, latestResult] = await Promise.allSettled([
    fetchJson<V2exTopic[]>(V2EX_HOT_ENDPOINT),
    fetchJson<V2exTopic[]>(V2EX_LATEST_ENDPOINT)
  ]);
  const topics = [
    ...(hotResult.status === "fulfilled" ? hotResult.value : []),
    ...(latestResult.status === "fulfilled" ? latestResult.value : [])
  ];
  const deduped = new Map<number, V2exTopic>();
  for (const topic of topics) {
    if (topic.id && !deduped.has(topic.id)) {
      deduped.set(topic.id, topic);
    }
  }

  const stories = [...deduped.values()]
    .map((topic, index) => toStory(topic, index + 1, config))
    .filter((story): story is StoryRecord => Boolean(story))
    .filter((story) => isWithinTargetDate(story.publishedAt, config))
    .sort((a, b) => b.hotScore - a.hotScore)
    .slice(0, config.candidateLimitPerSource);

  return stories.map((story, index) => ({
    ...story,
    sourceRank: index + 1,
    rank: index + 1
  }));
}

export async function hydrateV2exStory(story: StoryRecord, maxComments: number): Promise<StoryRecord> {
  const endpoint = new URL(V2EX_REPLIES_ENDPOINT);
  endpoint.searchParams.set("topic_id", String(story.id));

  const replies = await fetchJson<V2exReply[]>(endpoint.toString()).catch(() => []);
  const comments = replies
    .filter((reply) => reply.id)
    .slice(0, maxComments)
    .map((reply, index) => {
      const html = reply.content_rendered
        ? sanitizeForumHtml(reply.content_rendered)
        : sanitizeForumHtml(`<p>${reply.content ?? ""}</p>`);
      return createCommentNode({
        source: "v2ex",
        id: reply.id ?? `${story.id}-${index + 1}`,
        parentId: story.id,
        author: reply.member?.username,
        publishedAt: toIsoTimeFromUnix(reply.created),
        level: 1,
        sourceUrl: `${story.discussionUrl}#reply${reply.id ?? index + 1}`,
        floor: index + 1,
        textRawHtml: html
      });
    });

  return {
    ...story,
    comments
  };
}
