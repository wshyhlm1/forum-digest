import { afterEach, describe, expect, it } from "vitest";

import { createRunConfig, loadAppEnv } from "../src/shared/config.js";
import { resolveTargetDate } from "../src/shared/time.js";

const ORIGINAL_ENV = {
  SITE_BASE_URL: process.env.SITE_BASE_URL,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
};

afterEach(() => {
  if (ORIGINAL_ENV.SITE_BASE_URL === undefined) {
    delete process.env.SITE_BASE_URL;
  } else {
    process.env.SITE_BASE_URL = ORIGINAL_ENV.SITE_BASE_URL;
  }

  if (ORIGINAL_ENV.GITHUB_REPOSITORY === undefined) {
    delete process.env.GITHUB_REPOSITORY;
  } else {
    process.env.GITHUB_REPOSITORY = ORIGINAL_ENV.GITHUB_REPOSITORY;
  }
});

describe("site base url normalization", () => {
  it("adds https when SITE_BASE_URL is missing protocol", () => {
    process.env.SITE_BASE_URL = "lookingfor2018.github.io/hn-digest";

    const env = loadAppEnv();

    expect(env.siteBaseUrl).toBe("https://lookingfor2018.github.io/hn-digest/");
  });

  it("falls back to GITHUB_REPOSITORY when SITE_BASE_URL is invalid", () => {
    process.env.SITE_BASE_URL = "://bad-url";
    process.env.GITHUB_REPOSITORY = "lookingfor2018/hn-digest";

    const config = createRunConfig([]);

    expect(config.siteBaseUrl).toBe("https://lookingfor2018.github.io/hn-digest/");
  });
});

describe("target date resolution", () => {
  it("uses the previous China date for delayed scheduled digest runs", () => {
    const delayedScheduledRun = new Date("2026-07-02T18:01:00.000Z"); // 2026-07-03 02:01 Asia/Shanghai

    expect(resolveTargetDate("scheduled", delayedScheduledRun)).toBe("2026-07-02");
  });

  it("keeps manual runs on the current China date unless a target is provided", () => {
    const now = new Date("2026-07-02T18:01:00.000Z"); // 2026-07-03 02:01 Asia/Shanghai

    expect(resolveTargetDate("manual", now)).toBe("2026-07-03");
    expect(resolveTargetDate("manual", now, "2026-07-01")).toBe("2026-07-01");
  });
});
