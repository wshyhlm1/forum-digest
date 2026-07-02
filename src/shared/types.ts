export type RunMode = "scheduled" | "manual";
export type ScheduledSlot = "00:00";
export type RunSlot = ScheduledSlot | "manual";
export type StorySource = "hackernews" | "v2ex" | "linuxdo";

export type TranslationStatus =
  | "translated"
  | "partial"
  | "raw_only"
  | "cached"
  | "skipped_budget"
  | "failed";

export type PushStatus =
  | "pending"
  | "sent"
  | "failed"
  | "skipped_duplicate";

export interface SourceStatusRecord {
  ok: boolean;
  count: number;
  error?: string;
  attemptedAt?: string;
}

export type SourceStatusMap = Record<StorySource, SourceStatusRecord>;

export interface AppEnv {
  openAiApiKey: string;
  openAiBaseUrl: string;
  openAiModel: string;
  openAiReasoningEffort: string;
  llmClassifyEnabled: boolean;
  siteBaseUrl: string;
  barkServer: string;
  barkRecipientsFile?: string;
  barkRecipientNames: string[];
  barkNamedKeys?: string;
  barkIconUrl: string;
  listUrl: string;
  historyDays: number;
  articleSummaryMaxParagraphs: number;
  commentTranslationCharBudget: number;
  candidateLimitPerSource: number;
  maxCommentsPerStory: number;
  hnDailyStoryLimit: number;
  hnPublicCommentsPerStory: number;
  hnSnapshotStoryLimit: number;
  linuxDoCookie?: string;
}

export interface CliOptions {
  mode?: RunMode;
  slot?: RunSlot;
  limit?: number;
  listUrl?: string;
  dryRun?: boolean;
  skipPush?: boolean;
  batchId?: string;
  targetDate?: string;
  candidateLimitPerSource?: number;
  maxCommentsPerStory?: number;
  hnDailyStoryLimit?: number;
  hnPublicCommentsPerStory?: number;
  hnSnapshotStoryLimit?: number;
}

export interface RunConfig {
  mode: RunMode;
  timezone: string;
  slot: RunSlot;
  batchId: string;
  targetDate: string;
  targetStartIso: string;
  targetEndIso: string;
  listUrl: string;
  limit: number;
  historyDays: number;
  siteBaseUrl: string;
  articleSummaryMaxParagraphs: number;
  generatedAt: string;
  commentTranslationCharBudget: number;
  candidateLimitPerSource: number;
  maxCommentsPerStory: number;
  hnDailyStoryLimit: number;
  hnPublicCommentsPerStory: number;
  hnSnapshotStoryLimit: number;
  dryRun: boolean;
  skipPush: boolean;
}

export interface HnItemRecord {
  id: number;
  by?: string;
  descendants?: number;
  kids?: number[];
  score?: number;
  text?: string;
  time?: number;
  title?: string;
  type?: string;
  url?: string;
  dead?: boolean;
  deleted?: boolean;
  parent?: number;
}

export interface CommentNode {
  id: number | string;
  commentKey: string;
  parentId: number | string;
  author: string;
  publishedAt: string;
  level: number;
  hnUrl: string;
  sourceUrl: string;
  floor?: number;
  textRawHtml: string;
  textZhHtml: string;
  translationStatus: TranslationStatus;
  contentHash: string;
  children: CommentNode[];
  isDeleted?: boolean;
}

export interface StoryRecord {
  id: number;
  storyKey: string;
  source: StorySource;
  sourceLabel: string;
  rank: number;
  sourceRank: number;
  type: string;
  title: string;
  titleZh: string;
  url: string;
  domain: string;
  hnUrl: string;
  discussionUrl: string;
  author: string;
  score: number;
  publishedAt: string;
  commentsCount: number;
  category: string;
  relevanceScore: number;
  relevanceReason: string;
  hotScore: number;
  snapshotBestRank?: number;
  snapshotBestRankSource?: "topstories" | "beststories";
  snapshotMaxScore?: number;
  snapshotMaxComments?: number;
  snapshotFirstSeenAt?: string;
  snapshotLastSeenAt?: string;
  snapshotAppearances?: number;
  textRawHtml: string;
  textZhHtml: string;
  summaryRaw: string[];
  summaryZh: string[];
  highlightsZh: string[];
  translationStatus: TranslationStatus;
  contentHash: string;
  comments: CommentNode[];
}

export interface BatchPushRecord {
  status: PushStatus;
  sentAt?: string;
  messageUrl?: string;
  error?: string;
}

export interface BatchManifestStory {
  id: number;
  storyKey: string;
  source: StorySource;
  dailyBriefSourceId: string;
  sourceLabel: string;
  rank: number;
  sourceRank: number;
  title: string;
  titleZh: string;
  digestUrl: string;
  storyUrl: string;
  storyJsonUrl: string;
  hnUrl: string;
  discussionUrl: string;
  sourceUrl: string;
  publishedAt: string;
  score: number;
  commentsCount: number;
  category: string;
  summaryZhShort: string;
  relevanceReason: string;
  summaryZh: string[];
  highlightsZh: string[];
  translationStatus: TranslationStatus;
}

export interface BatchManifest {
  schemaVersion: 1;
  batchId: string;
  timezone: string;
  slot: RunSlot;
  generatedAt: string;
  targetDate: string;
  storyCount: number;
  sourceCounts: Record<StorySource, number>;
  sourceStatus: SourceStatusMap;
  latestIndexUrl: string;
  batchUrl: string;
  stories: BatchManifestStory[];
  push: BatchPushRecord;
}

export interface TranslationCacheEntry {
  key: string;
  translated: string;
  updatedAt: string;
  sourceHash: string;
  provider: string;
}

export interface TranslationCacheState {
  version: number;
  entries: Record<string, TranslationCacheEntry>;
}

export interface PushHistoryEntry {
  batchId: string;
  sentAt?: string;
  status: PushStatus;
  messageUrl?: string;
  error?: string;
}

export interface PushHistoryState {
  version: number;
  entries: PushHistoryEntry[];
}

export interface BatchHistoryEntry {
  batchId: string;
  slot: RunSlot;
  generatedAt: string;
  batchUrl: string;
  storyCount: number;
}

export interface BatchHistoryState {
  version: number;
  latestBatchId: string | null;
  entries: BatchHistoryEntry[];
}

export interface StateBundle {
  translationCache: TranslationCacheState;
  pushHistory: PushHistoryState;
  batches: BatchHistoryState;
}

export interface ProjectPaths {
  rootDir: string;
  stateDir: string;
  distDir: string;
}
