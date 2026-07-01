import { describe, expect, it } from "vitest";

import { protectText, restoreText } from "../src/translate/protect.js";

describe("protectText / restoreText", () => {
  it("protects URL and inline code and restores correctly", () => {
    const raw = "run `npm install` then open https://example.com/docs API";
    const protectedValue = protectText(raw);

    expect(protectedValue.text).toContain("__PH_0__");
    expect(protectedValue.text).toContain("__PH_1__");
    expect(protectedValue.text).toContain("__PH_2__");

    const restored = restoreText(protectedValue.text, protectedValue.placeholders);
    expect(restored).toBe(raw);
  });
});
