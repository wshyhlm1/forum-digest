import type { AppEnv, RunConfig, StoryRecord } from "../shared/types.js";
import { classifyStoryRelevance } from "../llm/qwen.js";
import { fetchHnCandidateIds, buildStoryCandidate, hydrateHnStory } from "./hn.js";
import { fetchLinuxDoCandidates, hydrateLinuxDoStory } from "./linuxdo.js";
import { fetchV2exCandidates, hydrateV2exStory } from "./v2ex.js";

async function fetchHnCandidates(config: RunConfig): Promise<StoryRecord[]> {
  const storyIds = await fetchHnCandidateIds(config);
  const stories = await Promise.all(
    storyIds.map((storyId, index) => buildStoryCandidate(storyId, index + 1, config))
  );
  return stories.filter((entry): entry is StoryRecord => Boolean(entry));
}

async function classifyAndSelect(
  sourceName: string,
  candidates: StoryRecord[],
  config: RunConfig,
  env: AppEnv,
  limit: number = config.limit
): Promise<StoryRecord[]> {
  const rankedCandidates = [...candidates].sort((a, b) => b.hotScore - a.hotScore).slice(0, config.candidateLimitPerSource);
  const classified: StoryRecord[] = [];

  for (const candidate of rankedCandidates) {
    const decision = await classifyStoryRelevance(candidate, env);
    if (!decision.isRelevant) {
      continue;
    }
    classified.push({
      ...candidate,
      category: decision.category,
      relevanceScore: decision.priority,
      relevanceReason: decision.reason,
      summaryZh: decision.summaryZh,
      highlightsZh: decision.highlightsZh
    });
  }

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

async function hydrateStory(story: StoryRecord, config: RunConfig): Promise<StoryRecord> {
  switch (story.source) {
    case "hackernews":
      return hydrateHnStory(story, config.maxCommentsPerStory);
    case "v2ex":
      return hydrateV2exStory(story, config.maxCommentsPerStory);
    case "linuxdo":
      return hydrateLinuxDoStory(story, config.maxCommentsPerStory);
    default:
      return story;
  }
}

export async function fetchStories(config: RunConfig, env: AppEnv): Promise<StoryRecord[]> {
  const sourceResults = await Promise.allSettled([
    fetchHnCandidates(config),
    fetchV2exCandidates(config),
    fetchLinuxDoCandidates(config)
  ]);
  const sourceNames = ["Hacker News", "V2EX", "Linux.do"];
  const selectedBySource: StoryRecord[][] = [];

  for (let index = 0; index < sourceResults.length; index += 1) {
    const result = sourceResults[index];
    const sourceName = sourceNames[index];
    if (result.status === "rejected") {
      console.warn(`[fetch] ${sourceName} unavailable:`, result.reason instanceof Error ? result.reason.message : String(result.reason));
      selectedBySource.push([]);
      continue;
    }
    const limit = sourceName === "Hacker News" ? config.hnDailyStoryLimit : config.limit;
    selectedBySource.push(await classifyAndSelect(sourceName, result.value, config, env, limit));
  }

  const hydratedGroups = await Promise.all(
    selectedBySource.map((stories) => Promise.all(stories.map((story) => hydrateStory(story, config))))
  );

  return hydratedGroups
    .flat()
    .map((story, index) => ({
      ...story,
      rank: index + 1
    }));
}
