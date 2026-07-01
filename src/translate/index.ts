import { JSDOM } from "jsdom";

import { sha256 } from "../shared/hash.js";
import type { AppEnv, RunConfig, StateBundle, StoryRecord } from "../shared/types.js";
import type { CommentNode, TranslationStatus } from "../shared/types.js";
import { translateTextWithFallback } from "./providers/translator.js";

export interface TranslationResult {
  stories: StoryRecord[];
  state: StateBundle;
}

export async function translateStories(
  stories: StoryRecord[],
  config: RunConfig,
  state: StateBundle,
  env: AppEnv
): Promise<TranslationResult> {
  const translatedStories = await Promise.all(
    stories.map((story) => translateStory(story, config, state, env))
  );

  return {
    stories: translatedStories,
    state
  };
}

function cloneCommentTree(nodes: CommentNode[]): CommentNode[] {
  return nodes.map((node) => ({
    ...node,
    children: cloneCommentTree(node.children)
  }));
}

function getStoryStatus(story: StoryRecord): TranslationStatus {
  const hasSkippedComment = flattenComments(story.comments).some(
    (comment) => comment.translationStatus === "skipped_budget" || comment.translationStatus === "failed"
  );
  if (hasSkippedComment) {
    return "partial";
  }
  if (story.titleZh || story.textZhHtml || story.summaryZh.length > 0) {
    return "translated";
  }
  return "raw_only";
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
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return out;
}

function extractHtmlTextLength(html: string): number {
  if (!html.trim()) {
    return 0;
  }
  const dom = new JSDOM(`<body>${html}</body>`);
  const { document, NodeFilter } = dom.window;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const parentTag = textNode.parentElement?.tagName?.toLowerCase() ?? "";
    const shouldSkip = ["code", "pre", "script", "style"].includes(parentTag);
    if (!shouldSkip && textNode.nodeValue?.trim()) {
      total += textNode.nodeValue.trim().length;
    }
    current = walker.nextNode();
  }
  return total;
}

async function translateStory(
  story: StoryRecord,
  config: RunConfig,
  state: StateBundle,
  env: AppEnv
): Promise<StoryRecord> {
  const commentTree = cloneCommentTree(story.comments);

  const titleZh = await translateCachedText(
    `story:${story.storyKey}:title:${sha256(story.title)}`,
    story.title,
    state,
    env
  );

  const textZhHtml = story.textRawHtml
    ? await translateHtmlWithCache(story.storyKey, story.textRawHtml, "story", state, env)
    : "";

  const summaryZh: string[] = story.summaryZh.length > 0 ? [...story.summaryZh] : [];
  if (summaryZh.length === 0) {
    for (const paragraph of story.summaryRaw) {
      const summary = await translateCachedText(
        `story:${story.storyKey}:summary:${sha256(paragraph)}`,
        paragraph,
        state,
        env
      );
      summaryZh.push(summary);
    }
  }

  let usedBudget = 0;
  const queue = [...commentTree];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }

    const textLength = extractHtmlTextLength(node.textRawHtml);
    if (usedBudget + textLength > config.commentTranslationCharBudget) {
      node.translationStatus = "skipped_budget";
      node.textZhHtml = node.textRawHtml;
    } else {
      try {
        node.textZhHtml = await translateHtmlWithCache(node.commentKey, node.textRawHtml, "comment", state, env);
        node.translationStatus = "translated";
      } catch {
        node.textZhHtml = node.textRawHtml;
        node.translationStatus = "failed";
      }
      usedBudget += textLength;
    }

    for (const child of node.children) {
      queue.push(child);
    }
  }

  const translatedStory: StoryRecord = {
    ...story,
    titleZh,
    textZhHtml,
    summaryZh,
    highlightsZh: story.highlightsZh,
    comments: commentTree
  };
  translatedStory.translationStatus = getStoryStatus(translatedStory);
  return translatedStory;
}

async function translateCachedText(
  cacheKey: string,
  rawText: string,
  state: StateBundle,
  env: AppEnv
): Promise<string> {
  const hash = sha256(rawText);
  const hit = state.translationCache.entries[cacheKey];
  if (hit?.sourceHash === hash && hit.translated) {
    return hit.translated;
  }

  const translated = await translateTextWithFallback(rawText, {
    apiKey: env.openAiApiKey,
    baseUrl: env.openAiBaseUrl,
    model: env.openAiModel || "qwen3.7-plus",
    reasoningEffort: env.openAiReasoningEffort
  });

  state.translationCache.entries[cacheKey] = {
    key: cacheKey,
    translated: translated.text,
    updatedAt: new Date().toISOString(),
    sourceHash: hash,
    provider: translated.provider
  };

  return translated.text;
}

async function translateHtmlWithCache(
  entityId: string,
  html: string,
  entityType: "story" | "comment",
  state: StateBundle,
  env: AppEnv
): Promise<string> {
  if (!html.trim()) {
    return "";
  }

  const dom = new JSDOM(`<body>${html}</body>`);
  const { document, NodeFilter } = dom.window;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();

  while (current) {
    const textNode = current as Text;
    const parentTag = textNode.parentElement?.tagName?.toLowerCase() ?? "";
    const shouldSkip = ["code", "pre", "script", "style"].includes(parentTag);
    if (!shouldSkip && textNode.nodeValue?.trim()) {
      textNodes.push(textNode);
    }
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    const source = node.nodeValue ?? "";
    const leading = source.match(/^\s*/)?.[0] ?? "";
    const trailing = source.match(/\s*$/)?.[0] ?? "";
    const core = source.trim();
    const cacheKey = `${entityType}:${entityId}:${sha256(core)}`;
    const translated = await translateCachedText(cacheKey, core, state, env);
    node.nodeValue = `${leading}${translated}${trailing}`;
  }

  return document.body.innerHTML;
}
