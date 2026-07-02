import type { AppEnv, RunConfig, SourceStatusMap, StoryRecord, StorySource } from "../shared/types.js";
import { classifyStoryRelevance } from "../llm/qwen.js";
import { fetchHnCandidateIds, buildStoryCandidate, hydrateHnStory } from "./hn.js";
import { fetchLinuxDoCandidates, hydrateLinuxDoStory } from "./linuxdo.js";
import { fetchV2exCandidates, hydrateV2exStory } from "./v2ex.js";

const MAX_CONCURRENT_CLASSIFICATIONS = 4;

export interface FetchStoriesResult {
  stories: StoryRecord[];
  sourceStatus: SourceStatusMap;
}

interface SourceFetchConfig {
  source: StorySource;
  name: string;
  limit: (config: RunConfig) => number;
  fetch: (config: RunConfig, env: AppEnv) => Promise<StoryRecord[]>;
}

type SourceFetchResult =
  | {
      sourceConfig: SourceFetchConfig;
      candidates: StoryRecord[];
    }
  | {
      sourceConfig: SourceFetchConfig;
      error: string;
    };

async function fetchHnCandidates(config: RunConfig): Promise<StoryRecord[]> {
  const storyIds = await fetchHnCandidateIds(config);
  const stories = await Promise.all(
    storyIds.map((storyId, index) => buildStoryCandidate(storyId, index + 1, config))
  );
  return stories.filter((entry): entry is StoryRecord => Boolean(entry));
}

const SOURCE_FETCHERS: SourceFetchConfig[] = [
  {
    source: "hackernews",
    name: "Hacker News",
    limit: (config) => config.hnDailyStoryLimit,
    fetch: (config) => fetchHnCandidates(config)
  },
  {
    source: "v2ex",
    name: "V2EX",
    limit: (config) => config.limit,
    fetch: (config) => fetchV2exCandidates(config)
  },
  {
    source: "linuxdo",
    name: "Linux.do",
    limit: (config) => config.limit,
    fetch: (config, env) => fetchLinuxDoCandidates(config, env)
  }
];

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function classifyAndSelect(
  sourceName: string,
  candidates: StoryRecord[],
  config: RunConfig,
  env: AppEnv,
  limit: number = config.limit
): Promise<StoryRecord[]> {
  const rankedCandidates = [...candidates].sort((a, b) => b.hotScore - a.hotScore).slice(0, config.candidateLimitPerSource);
  const classified = (await mapWithConcurrency(
    rankedCandidates,
    MAX_CONCURRENT_CLASSIFICATIONS,
    async (candidate) => {
    const decision = await classifyStoryRelevance(candidate, env);
    if (!decision.isRelevant) {
      return null;
    }
    return {
      ...candidate,
      category: decision.category,
      relevanceScore: decision.priority,
      relevanceReason: decision.reason,
      summaryZh: decision.summaryZh,
      highlightsZh: decision.highlightsZh
    };
    }
  )).filter((story): story is StoryRecord => Boolean(story));

  const selected = classified
    .sort((a, b) => (b.relevanceScore + b.hotScore / 10) - (a.relevanceScore + a.hotScore / 10))
    .slice(0, limit)
    .map((story, index) => ({
      ...story,
      sourceRank: index + 1
    }));

  if (selected.length === 0 && candidates.length > 0) {
    console.warn(`[fetch] ${sourceName} produced candidates, but none matched AI/tech relevance.`);
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createEmptySourceStatus(config: RunConfig): SourceStatusMap {
  return {
    hackernews: { ok: false, count: 0, attemptedAt: config.generatedAt },
    v2ex: { ok: false, count: 0, attemptedAt: config.generatedAt },
    linuxdo: { ok: false, count: 0, attemptedAt: config.generatedAt }
  };
}

async function hydrateStory(story: StoryRecord, config: RunConfig, env: AppEnv): Promise<StoryRecord> {
  switch (story.source) {
    case "hackernews":
      return hydrateHnStory(story, config.maxCommentsPerStory);
    case "v2ex":
      return hydrateV2exStory(story, config.maxCommentsPerStory);
    case "linuxdo":
      return hydrateLinuxDoStory(story, config.maxCommentsPerStory, env);
    default:
      return story;
  }
}

async function hydrateStoriesSafely(stories: StoryRecord[], config: RunConfig, env: AppEnv): Promise<StoryRecord[]> {
  return Promise.all(
    stories.map(async (story) => {
      try {
        return await hydrateStory(story, config, env);
      } catch (error) {
        console.warn(`[fetch] ${story.sourceLabel} story ${story.storyKey} detail unavailable:`, errorMessage(error));
        return story;
      }
    })
  );
}

export async function fetchStories(config: RunConfig, env: AppEnv): Promise<FetchStoriesResult> {
  const sourceStatus = createEmptySourceStatus(config);
  const selectedBySource: StoryRecord[][] = [];
  const fetchResults: SourceFetchResult[] = await Promise.all(
    SOURCE_FETCHERS.map(async (sourceConfig) => {
      try {
        return {
          sourceConfig,
          candidates: await sourceConfig.fetch(config, env)
        };
      } catch (error) {
        return {
          sourceConfig,
          error: errorMessage(error)
        };
      }
    })
  );

  for (const result of fetchResults) {
    const { sourceConfig } = result;
    if ("error" in result) {
      console.warn(`[fetch] ${sourceConfig.name} unavailable:`, result.error);
      sourceStatus[sourceConfig.source] = {
        ok: false,
        count: 0,
        error: result.error,
        attemptedAt: config.generatedAt
      };
      selectedBySource.push([]);
      continue;
    }

    try {
      console.log(
        `[fetch] classifying ${result.candidates.length} ${sourceConfig.name} candidates (limit ${sourceConfig.limit(config)})`
      );
      const selected = await classifyAndSelect(
        sourceConfig.name,
        result.candidates,
        config,
        env,
        sourceConfig.limit(config)
      );
      console.log(`[fetch] selected ${selected.length} ${sourceConfig.name} stories`);
      sourceStatus[sourceConfig.source] = {
        ok: true,
        count: selected.length,
        attemptedAt: config.generatedAt
      };
      selectedBySource.push(selected);
    } catch (error) {
      const message = errorMessage(error);
      console.warn(`[fetch] ${sourceConfig.name} classification unavailable:`, message);
      sourceStatus[sourceConfig.source] = {
        ok: false,
        count: 0,
        error: message,
        attemptedAt: config.generatedAt
      };
      selectedBySource.push([]);
    }
  }

  const hydratedGroups = await Promise.all(
    selectedBySource.map((stories) => hydrateStoriesSafely(stories, config, env))
  );

  const stories = hydratedGroups
    .flat()
    .map((story, index) => ({
      ...story,
      rank: index + 1
    }));

  for (const source of Object.keys(sourceStatus) as StorySource[]) {
    sourceStatus[source].count = stories.filter((story) => story.source === source).length;
  }

  return {
    stories,
    sourceStatus
  };
}
