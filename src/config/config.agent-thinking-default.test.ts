import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("agent thinkingDefault config", () => {
  it("accepts agents.list[].thinkingDefault", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          thinkingDefault: "medium",
        },
        list: [
          {
            id: "codex",
            thinkingDefault: "xhigh",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });
});
