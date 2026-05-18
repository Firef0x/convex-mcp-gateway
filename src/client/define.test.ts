import { describe, expect, test } from "vitest";
import { defineMcpQuery } from "./index.js";

// defineMcpQuery's TS signature requires a real Convex function
// reference; runtime validation runs first regardless of TS, so we
// cast through unknown to exercise the runtime check on bad input.
function call(name: string) {
  return (defineMcpQuery as unknown as (c: unknown) => unknown)({
    name,
    description: "test",
    fn: {},
    args: {},
  });
}

describe("defineMcp* name validation", () => {
  test("accepts a compliant name", () => {
    expect(() => call("invoices_list")).not.toThrow();
  });

  test("rejects a dotted name with a helpful message", () => {
    expect(() => call("invoices.list")).toThrow(
      /violates the required pattern.*use "namespace_tool"/s,
    );
  });

  test("rejects names with whitespace, slashes, or other punctuation", () => {
    for (const bad of [
      "with space",
      "with/slash",
      "with:colon",
      "with(paren)",
      "ümlaut",
      "",
    ]) {
      expect(
        () => call(bad),
        `name "${bad}" should be rejected`,
      ).toThrow(/violates the required pattern/);
    }
  });

  test("rejects names longer than 64 chars", () => {
    expect(() => call("a".repeat(65))).toThrow(
      /violates the required pattern/,
    );
  });

  test("accepts hyphens, digits, underscores up to 64 chars", () => {
    expect(() => call("a-b_c-1234")).not.toThrow();
    expect(() => call("a".repeat(64))).not.toThrow();
  });
});
