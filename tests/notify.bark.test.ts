import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __notifyInternals, notifyBatch } from "../src/notify/index.js";
import type { AppEnv, BatchManifest, RunConfig, StateBundle } from "../src/shared/types.js";

function createConfig(): RunConfig {
  return {
    mode: "manual",
    timezone: "Asia/Shanghai",
    slot: "manual",
    batchId: "2026-03-22",
    targetDate: "2026-03-22",
    targetStartIso: "2026-03-21T16:00:00.000Z",
    targetEndIso: "2026-03-22T16:00:00.000Z",
    listUrl: "https://news.ycombinator.com/best?h=24",
    limit: 10,
    historyDays: 7,
    siteBaseUrl: "https://example.github.io/hn/",
    articleSummaryMaxParagraphs: 5,
    generatedAt: "2026-03-22T04:00:00.000Z",
    commentTranslationCharBudget: 320000,
    candidateLimitPerSource: 80,
    maxCommentsPerStory: 240,
    hnDailyStoryLimit: 20,
    hnPublicCommentsPerStory: 8,
    hnSnapshotStoryLimit: 120,
    dryRun: false,
    skipPush: false
  };
}

function createManifest(batchId = "2026-03-22"): BatchManifest {
  return {
    schemaVersion: 1,
    batchId,
    timezone: "Asia/Shanghai",
    slot: "manual",
    generatedAt: "2026-03-22T04:00:00.000Z",
    targetDate: "2026-03-22",
    storyCount: 9,
    sourceCounts: {
      hackernews: 4,
      v2ex: 5,
      linuxdo: 0
    },
    sourceStatus: {
      hackernews: { ok: true, count: 4, attemptedAt: "2026-03-22T04:00:00.000Z" },
      v2ex: { ok: true, count: 5, attemptedAt: "2026-03-22T04:00:00.000Z" },
      linuxdo: {
        ok: true,
        count: 0,
        disabled: true,
        reason: "linuxdo source disabled by project decision",
        attemptedAt: "2026-03-22T04:00:00.000Z"
      }
    },
    latestIndexUrl: "https://example.github.io/hn/",
    batchUrl: `https://example.github.io/hn/batches/${batchId}/`,
    stories: [],
    push: { status: "pending" }
  };
}

function createState(): StateBundle {
  return {
    translationCache: { version: 1, entries: {} },
    pushHistory: { version: 1, entries: [] },
    batches: { version: 1, latestBatchId: null, entries: [] }
  };
}

function createEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    openAiApiKey: "",
    openAiBaseUrl: "https://example.com/v1",
    openAiModel: "qwen3.7-plus",
    openAiReasoningEffort: "high",
    llmClassifyEnabled: false,
    siteBaseUrl: "https://example.github.io/hn/",
    barkServer: "https://api.day.app",
    barkRecipientsFile: "",
    barkRecipientNames: ["liyu"],
    barkNamedKeys: "",
    barkIconUrl: "https://news.ycombinator.com/y18.svg",
    listUrl: "https://news.ycombinator.com/best?h=24",
    historyDays: 7,
    articleSummaryMaxParagraphs: 5,
    commentTranslationCharBudget: 320000,
    candidateLimitPerSource: 80,
    maxCommentsPerStory: 240,
    hnDailyStoryLimit: 20,
    hnPublicCommentsPerStory: 8,
    hnSnapshotStoryLimit: 120,
    linuxDoCookie: "",
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("notify bark", () => {
  it("prefers CSV recipient keys over named keys", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "hn-notify-"));
    const csvPath = path.join(tempDir, "recipients.csv");
    await writeFile(
      csvPath,
      "name,address,region\nliyu,csv_key,Shanghai\nalice,alice_key,Shanghai\n",
      "utf8"
    );

    const recipients = await __notifyInternals.resolveRecipients(
      createEnv({
        barkRecipientsFile: csvPath,
        barkNamedKeys: "liyu:named_key"
      })
    );

    expect(recipients).toEqual([{ name: "liyu", key: "csv_key" }]);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips duplicate batch pushes and records history", async () => {
    const state = createState();
    state.pushHistory.entries.push({
      batchId: "2026-03-22",
      status: "sent",
      messageUrl: "https://example.github.io/hn/batches/2026-03-22/"
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await notifyBatch(createManifest(), createConfig(), state, createEnv());
    expect(result.status).toBe("skipped_duplicate");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.state.pushHistory.entries[0]?.status).toBe("skipped_duplicate");
  });

  it("sends forum digest payload with named key fallback", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, message: "success" })
    });
    vi.stubGlobal("fetch", fetchSpy);

    const state = createState();
    const env = createEnv({
      barkRecipientNames: ["liyu"],
      barkRecipientsFile: "",
      barkNamedKeys: "liyu:fallback_key",
      barkIconUrl: "https://news.ycombinator.com/logo.svg",
      barkServer: "https://api.day.app/"
    });

    const result = await notifyBatch(createManifest(), createConfig(), state, env);
    expect(result.status).toBe("sent");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.day.app/push");

    const payload = JSON.parse(String(requestInit.body)) as Record<string, string>;
    expect(payload.device_key).toBe("fallback_key");
    expect(payload.icon).toBe("https://news.ycombinator.com/logo.svg");
    expect(payload.url).toBe("https://example.github.io/hn/batches/2026-03-22/");
    expect(payload.title).toContain("AI/科技论坛日报已更新 |");
    expect(payload.body).toContain("目标日期 2026-03-22");
    expect(payload.body).toContain("HN 4、V2EX 5");
    expect(payload.body).not.toContain("Linux.do");
  });
});
