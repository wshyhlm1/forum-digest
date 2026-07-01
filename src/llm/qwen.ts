import type { AppEnv, StoryRecord } from "../shared/types.js";
import { plainTextFromHtml } from "../fetch/source-utils.js";

export interface RelevanceDecision {
  isRelevant: boolean;
  category: string;
  reason: string;
  priority: number;
  summaryZh: string[];
  highlightsZh: string[];
}

const KEYWORD_GROUPS: Array<{ category: string; keywords: string[] }> = [
  {
    category: "AI",
    keywords: [
      "ai",
      "aigc",
      "agent",
      "llm",
      "openai",
      "anthropic",
      "claude",
      "chatgpt",
      "gemini",
      "qwen",
      "deepseek",
      "模型",
      "大模型",
      "智能体",
      "生成式",
      "推理",
      "提示词",
      "向量",
      "rag"
    ]
  },
  {
    category: "开发工具",
    keywords: [
      "developer",
      "programming",
      "github",
      "typescript",
      "javascript",
      "python",
      "rust",
      "golang",
      "database",
      "postgres",
      "sqlite",
      "linux",
      "cli",
      "api",
      "开源",
      "编程",
      "开发",
      "数据库",
      "命令行",
      "服务器",
      "运维"
    ]
  },
  {
    category: "科技产品",
    keywords: [
      "startup",
      "product",
      "cloud",
      "security",
      "privacy",
      "hardware",
      "semiconductor",
      "gpu",
      "nvidia",
      "apple",
      "google",
      "microsoft",
      "amazon",
      "产品",
      "云服务",
      "安全",
      "隐私",
      "芯片",
      "半导体",
      "机器人"
    ]
  }
];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function chatCompletionUrls(baseUrl: string): string[] {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith("/v1") || base.includes("/compatible-mode/v1")) {
    return [`${base}/chat/completions`];
  }
  return [`${base}/v1/chat/completions`, `${base}/chat/completions`];
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const text = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [text, text.match(/\{[\s\S]*\}/)?.[0] ?? ""].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const object = payload as Record<string, unknown>;
  const choices = object.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).text ?? "") : ""))
          .join("")
          .trim();
      }
    }
    if (typeof first.text === "string") {
      return first.text;
    }
  }
  return typeof object.output_text === "string" ? object.output_text : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 6);
}

function clampPriority(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function storyTextForJudgement(story: StoryRecord): string {
  return [
    story.title,
    story.category,
    story.domain,
    plainTextFromHtml(story.textRawHtml),
    story.summaryRaw.join("\n")
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

export function heuristicRelevance(story: StoryRecord): RelevanceDecision {
  const text = storyTextForJudgement(story).toLowerCase();
  let bestCategory = "";
  let matches = 0;

  for (const group of KEYWORD_GROUPS) {
    const groupMatches = group.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
    if (groupMatches > matches) {
      matches = groupMatches;
      bestCategory = group.category;
    }
  }

  const isRelevant = matches > 0;
  const summarySeed = story.summaryRaw.length > 0
    ? story.summaryRaw.slice(0, 2)
    : [plainTextFromHtml(story.textRawHtml).slice(0, 260)].filter(Boolean);

  return {
    isRelevant,
    category: bestCategory || "科技",
    reason: isRelevant ? `命中 ${matches} 个 AI/科技关键词。` : "未命中明确的 AI/科技关键词。",
    priority: Math.max(0, Math.min(100, Math.round(matches * 18 + story.hotScore / 10))),
    summaryZh: summarySeed,
    highlightsZh: []
  };
}

async function classifyWithQwen(story: StoryRecord, env: AppEnv, heuristic: RelevanceDecision): Promise<RelevanceDecision> {
  const system = [
    "你是一个面向中文科技日报的论坛内容筛选和整理助手。",
    "判断帖子是否与 AI、科技、开发工具、编程、开源、云服务、硬件、安全、科技产品相关。",
    "只输出合法 JSON，不要输出 Markdown。字段固定为：isRelevant, category, reason, priority, summaryZh, highlightsZh。",
    "summaryZh 是 1-3 条中文短摘要；highlightsZh 是 0-5 条中文看点。priority 是 0-100。"
  ].join("\n");
  const userPayload = {
    source: story.sourceLabel,
    title: story.title,
    url: story.url,
    forumUrl: story.discussionUrl,
    score: story.score,
    replies: story.commentsCount,
    nodeOrCategory: story.category,
    text: storyTextForJudgement(story)
  };

  const body = {
    model: env.openAiModel,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload, null, 2) }
    ]
  };

  for (const url of chatCompletionUrls(env.openAiBaseUrl)) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    }).catch(() => null);

    if (!response?.ok) {
      continue;
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    const content = extractResponseText(payload);
    const parsed = content ? parseJsonObject(content) : null;
    if (!parsed) {
      continue;
    }

    return {
      isRelevant: Boolean(parsed.isRelevant),
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : heuristic.category,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : heuristic.reason,
      priority: clampPriority(parsed.priority, heuristic.priority),
      summaryZh: asStringArray(parsed.summaryZh).length > 0 ? asStringArray(parsed.summaryZh) : heuristic.summaryZh,
      highlightsZh: asStringArray(parsed.highlightsZh)
    };
  }

  return heuristic;
}

export async function classifyStoryRelevance(story: StoryRecord, env: AppEnv): Promise<RelevanceDecision> {
  const heuristic = heuristicRelevance(story);
  if (!env.llmClassifyEnabled || !env.openAiApiKey) {
    return heuristic;
  }
  try {
    return await classifyWithQwen(story, env, heuristic);
  } catch {
    return heuristic;
  }
}
