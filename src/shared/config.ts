import "dotenv/config";

import path from "node:path";

import {
  DEFAULT_ARTICLE_SUMMARY_MAX_PARAGRAPHS,
  DEFAULT_BARK_ICON_URL,
  DEFAULT_BARK_SERVER,
  DEFAULT_CANDIDATE_LIMIT_PER_SOURCE,
  DEFAULT_COMMENT_TRANSLATION_CHAR_BUDGET,
  DEFAULT_HN_DAILY_STORY_LIMIT,
  DEFAULT_HN_PUBLIC_COMMENTS_PER_STORY,
  DEFAULT_HN_SNAPSHOT_STORY_LIMIT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_LIMIT,
  DEFAULT_LIST_URL,
  DEFAULT_MAX_COMMENTS_PER_STORY,
  DEFAULT_TIMEZONE
} from "./constants.js";
import { formatBatchId, getChinaDayRangeIso, resolveSlot, resolveTargetDate } from "./time.js";
import type { AppEnv, CliOptions, ProjectPaths, RunConfig, RunMode, RunSlot } from "./types.js";

function parseInteger(value: string | undefined, fallbackValue: number): number {
  if (!value) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFirstEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function parseBoolean(value: string | undefined, fallbackValue: boolean): boolean {
  if (!value) {
    return fallbackValue;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function ensureValidAbsoluteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = /^https?:\/\//i.test(trimmed)
    ? [trimmed]
    : [`https://${trimmed.replace(/^\/+/, "")}`];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
    } catch {
      continue;
    }
  }

  return null;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    switch (token) {
      case "--mode":
        options.mode = value as RunMode;
        index += 1;
        break;
      case "--slot":
        options.slot = value as RunSlot;
        index += 1;
        break;
      case "--limit":
        options.limit = parseInteger(value, DEFAULT_LIMIT);
        index += 1;
        break;
      case "--list-url":
        options.listUrl = value;
        index += 1;
        break;
      case "--batch-id":
        options.batchId = value;
        index += 1;
        break;
      case "--target-date":
        options.targetDate = value;
        index += 1;
        break;
      case "--candidate-limit":
        options.candidateLimitPerSource = parseInteger(value, DEFAULT_CANDIDATE_LIMIT_PER_SOURCE);
        index += 1;
        break;
      case "--max-comments-per-story":
        options.maxCommentsPerStory = parseInteger(value, DEFAULT_MAX_COMMENTS_PER_STORY);
        index += 1;
        break;
      case "--hn-daily-limit":
        options.hnDailyStoryLimit = parseInteger(value, DEFAULT_HN_DAILY_STORY_LIMIT);
        index += 1;
        break;
      case "--hn-public-comments":
        options.hnPublicCommentsPerStory = parseInteger(value, DEFAULT_HN_PUBLIC_COMMENTS_PER_STORY);
        index += 1;
        break;
      case "--hn-snapshot-limit":
        options.hnSnapshotStoryLimit = parseInteger(value, DEFAULT_HN_SNAPSHOT_STORY_LIMIT);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-push":
        options.skipPush = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function deriveSiteBaseUrl(): string {
  const envValue = process.env.SITE_BASE_URL?.trim();
  if (envValue) {
    const normalized = ensureValidAbsoluteUrl(envValue);
    if (normalized) {
      return normalized;
    }
  }

  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!repo || !repo.includes("/")) {
    return "https://example.github.io/hacker-news-digest/";
  }

  const [owner, repository] = repo.split("/");
  return ensureValidAbsoluteUrl(`https://${owner}.github.io/${repository}/`)
    ?? "https://example.github.io/hacker-news-digest/";
}

export function getProjectPaths(rootDir: string = process.cwd()): ProjectPaths {
  return {
    rootDir,
    stateDir: path.join(rootDir, "state"),
    distDir: path.join(rootDir, "dist")
  };
}

export function loadAppEnv(): AppEnv {
  return {
    openAiApiKey: readFirstEnv("QWEN_API_KEY", "MKT_LLM_TRANSLATE_API_KEY", "OPENAI_API_KEY"),
    openAiBaseUrl: readFirstEnv("QWEN_BASE_URL", "MKT_LLM_TRANSLATE_BASE_URL", "OPENAI_BASE_URL")
      || "https://coding.dashscope.aliyuncs.com/v1",
    openAiModel: readFirstEnv("QWEN_MODEL", "MKT_LLM_TRANSLATE_MODEL", "OPENAI_MODEL") || "qwen3.7-plus",
    openAiReasoningEffort: readFirstEnv("QWEN_EFFORT", "OPENAI_REASONING_EFFORT") || "high",
    llmClassifyEnabled: parseBoolean(process.env.LLM_CLASSIFY_ENABLED, true),
    siteBaseUrl: deriveSiteBaseUrl(),
    barkServer: process.env.BARK_SERVER?.trim() ?? DEFAULT_BARK_SERVER,
    barkRecipientsFile: process.env.BARK_RECIPIENTS_FILE?.trim(),
    barkRecipientNames: parseList(process.env.BARK_RECIPIENT_NAMES),
    barkNamedKeys: process.env.BARK_NAMED_KEYS?.trim(),
    barkIconUrl: process.env.BARK_ICON_URL?.trim() ?? DEFAULT_BARK_ICON_URL,
    listUrl: process.env.LIST_URL?.trim() ?? DEFAULT_LIST_URL,
    historyDays: parseInteger(process.env.HISTORY_DAYS, DEFAULT_HISTORY_DAYS),
    articleSummaryMaxParagraphs: parseInteger(
      process.env.ARTICLE_SUMMARY_MAX_PARAGRAPHS,
      DEFAULT_ARTICLE_SUMMARY_MAX_PARAGRAPHS
    ),
    commentTranslationCharBudget: parseInteger(
      process.env.COMMENT_TRANSLATION_CHAR_BUDGET,
      DEFAULT_COMMENT_TRANSLATION_CHAR_BUDGET
    ),
    candidateLimitPerSource: parseInteger(
      process.env.CANDIDATE_LIMIT_PER_SOURCE,
      DEFAULT_CANDIDATE_LIMIT_PER_SOURCE
    ),
    maxCommentsPerStory: parseInteger(
      process.env.MAX_COMMENTS_PER_STORY,
      DEFAULT_MAX_COMMENTS_PER_STORY
    ),
    hnDailyStoryLimit: parseInteger(
      process.env.HN_DAILY_STORY_LIMIT,
      DEFAULT_HN_DAILY_STORY_LIMIT
    ),
    hnPublicCommentsPerStory: parseInteger(
      process.env.HN_PUBLIC_COMMENTS_PER_STORY,
      DEFAULT_HN_PUBLIC_COMMENTS_PER_STORY
    ),
    hnSnapshotStoryLimit: parseInteger(
      process.env.HN_SNAPSHOT_STORY_LIMIT,
      DEFAULT_HN_SNAPSHOT_STORY_LIMIT
    ),
    linuxDoCookie: process.env.LINUXDO_COOKIE?.trim()
  };
}

export function createRunConfig(argv: string[] = process.argv.slice(2), now: Date = new Date()): RunConfig {
  const cliOptions = parseCliArgs(argv);
  const env = loadAppEnv();
  const mode = cliOptions.mode ?? "manual";
  const slot = resolveSlot(mode, cliOptions.slot, now);
  const targetDate = resolveTargetDate(mode, now, cliOptions.targetDate);
  const targetRange = getChinaDayRangeIso(targetDate);

  return {
    mode,
    timezone: DEFAULT_TIMEZONE,
    slot,
    batchId: cliOptions.batchId ?? targetDate ?? formatBatchId(now),
    targetDate,
    targetStartIso: targetRange.startIso,
    targetEndIso: targetRange.endIso,
    listUrl: cliOptions.listUrl ?? env.listUrl,
    limit: cliOptions.limit ?? DEFAULT_LIMIT,
    historyDays: env.historyDays,
    siteBaseUrl: env.siteBaseUrl,
    articleSummaryMaxParagraphs: env.articleSummaryMaxParagraphs,
    generatedAt: now.toISOString(),
    commentTranslationCharBudget: env.commentTranslationCharBudget,
    candidateLimitPerSource: cliOptions.candidateLimitPerSource ?? env.candidateLimitPerSource,
    maxCommentsPerStory: cliOptions.maxCommentsPerStory ?? env.maxCommentsPerStory,
    hnDailyStoryLimit: cliOptions.hnDailyStoryLimit ?? env.hnDailyStoryLimit,
    hnPublicCommentsPerStory: cliOptions.hnPublicCommentsPerStory ?? env.hnPublicCommentsPerStory,
    hnSnapshotStoryLimit: cliOptions.hnSnapshotStoryLimit ?? env.hnSnapshotStoryLimit,
    dryRun: cliOptions.dryRun ?? false,
    skipPush: cliOptions.skipPush ?? false
  };
}
