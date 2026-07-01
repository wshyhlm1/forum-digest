export const DEFAULT_LIST_URL = "https://news.ycombinator.com/best?h=24";
export const DEFAULT_LIMIT = 10;
export const DEFAULT_HN_DAILY_STORY_LIMIT = 20;
export const DEFAULT_HN_PUBLIC_COMMENTS_PER_STORY = 8;
export const DEFAULT_HN_SNAPSHOT_STORY_LIMIT = 120;
export const DEFAULT_CANDIDATE_LIMIT_PER_SOURCE = 80;
export const DEFAULT_HISTORY_DAYS = 7;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_ARTICLE_SUMMARY_MAX_PARAGRAPHS = 5;
export const DEFAULT_COMMENT_TRANSLATION_CHAR_BUDGET = 320_000;
export const DEFAULT_MAX_COMMENTS_PER_STORY = 1000;
export const DEFAULT_BARK_SERVER = "https://api.day.app";
export const DEFAULT_BARK_ICON_URL = "https://news.ycombinator.com/y18.svg";

export const SCHEDULED_SLOTS = ["00:00"] as const;
export const HN_ITEM_ENDPOINT = "https://hacker-news.firebaseio.com/v0/item";
export const HN_TOP_STORIES_ENDPOINT = "https://hacker-news.firebaseio.com/v0/topstories.json";
export const HN_BEST_STORIES_ENDPOINT = "https://hacker-news.firebaseio.com/v0/beststories.json";
