import { describe, expect, test } from "vitest";
import { parseAuthorizerDecision } from "./dispatch.js";

describe("parseAuthorizerDecision", () => {
  test("accepts the canonical { allowed: boolean } shape", () => {
    expect(parseAuthorizerDecision({ allowed: true })).toEqual({
      allowed: true,
      reason: undefined,
    });
    expect(parseAuthorizerDecision({ allowed: false })).toEqual({
      allowed: false,
      reason: undefined,
    });
  });

  test("preserves a string reason field", () => {
    expect(
      parseAuthorizerDecision({ allowed: false, reason: "Forbidden" }),
    ).toEqual({ allowed: false, reason: "Forbidden" });
  });

  test("ignores non-string reason fields without crashing", () => {
    expect(
      parseAuthorizerDecision({ allowed: true, reason: 42 }),
    ).toEqual({ allowed: true, reason: undefined });
    expect(
      parseAuthorizerDecision({ allowed: false, reason: null }),
    ).toEqual({ allowed: false, reason: undefined });
  });

  test("treats extra fields as non-breaking schema evolution", () => {
    // Adding optional keys to McpAuthorizerDecision later must not break
    // the runtime parser. Extra fields are silently dropped.
    expect(
      parseAuthorizerDecision({ allowed: true, futureField: "ignored" }),
    ).toEqual({ allowed: true, reason: undefined });
  });

  test("denies (with explanatory reason) when the shape is wrong", () => {
    const expected = {
      allowed: false,
      reason: expect.stringContaining("invalid shape"),
    };
    expect(parseAuthorizerDecision(null)).toMatchObject(expected);
    expect(parseAuthorizerDecision(undefined)).toMatchObject(expected);
    expect(parseAuthorizerDecision("not an object")).toMatchObject(expected);
    expect(parseAuthorizerDecision(42)).toMatchObject(expected);
    expect(parseAuthorizerDecision({})).toMatchObject(expected);
    expect(
      parseAuthorizerDecision({ allowed: "true" }),
    ).toMatchObject(expected);
    expect(
      parseAuthorizerDecision({ reason: "missing allowed key" }),
    ).toMatchObject(expected);
    expect(parseAuthorizerDecision([true])).toMatchObject(expected);
  });
});
