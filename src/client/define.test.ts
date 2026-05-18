import { describe, expect, test } from "vitest";
import { v } from "convex/values";
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

function callWithReturns(returns: unknown) {
  return (defineMcpQuery as unknown as (c: unknown) => unknown)({
    name: "demo_tool",
    description: "test",
    fn: {},
    args: {},
    returns,
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

describe("defineMcp* outputSchema (from returns: validator)", () => {
  test("omitted returns → no outputSchema on the result", () => {
    const tool = (defineMcpQuery as unknown as (c: unknown) => any)({
      name: "demo_tool",
      description: "x",
      fn: {},
      args: {},
    });
    expect(tool.outputSchema).toBeUndefined();
  });

  test("v.object({...}) → JSON Schema object with properties", () => {
    const tool = callWithReturns(
      v.object({ total: v.float64(), label: v.string() }),
    ) as any;
    expect(tool.outputSchema).toEqual({
      type: "object",
      properties: {
        total: { type: "number" },
        label: { type: "string" },
      },
      required: ["total", "label"],
      additionalProperties: false,
    });
  });

  test("v.id('notes') → string + format + table annotation", () => {
    const tool = callWithReturns(v.id("notes")) as any;
    expect(tool.outputSchema).toEqual({
      type: "string",
      format: "convex-id",
      "x-convex-table": "notes",
    });
  });

  test("v.null() → { type: 'null' }", () => {
    const tool = callWithReturns(v.null()) as any;
    expect(tool.outputSchema).toEqual({ type: "null" });
  });

  test("v.union(...) → anyOf", () => {
    const tool = callWithReturns(
      v.union(v.literal("ok"), v.literal("err")),
    ) as any;
    expect(tool.outputSchema).toEqual({
      anyOf: [{ const: "ok" }, { const: "err" }],
    });
  });

  test("v.array(v.string()) → array schema with item type", () => {
    const tool = callWithReturns(v.array(v.string())) as any;
    expect(tool.outputSchema).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("v.any() → permissive empty schema", () => {
    const tool = callWithReturns(v.any()) as any;
    expect(tool.outputSchema).toEqual({});
  });
});
