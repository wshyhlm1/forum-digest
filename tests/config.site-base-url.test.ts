import { afterEach, describe, expect, it } from "vitest";

import { createRunConfig, loadAppEnv } from "../src/shared/config.js";

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
