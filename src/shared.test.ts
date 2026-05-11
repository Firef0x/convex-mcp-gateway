import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import {
  convexValidatorToJsonSchema,
  propertyValidatorsToObjectSchema,
} from "./shared.js";

describe("convexValidatorToJsonSchema", () => {
  test("primitive validators map to their JSON schema counterparts", () => {
    expect(convexValidatorToJsonSchema(v.string())).toEqual({ type: "string" });
    expect(convexValidatorToJsonSchema(v.number())).toEqual({ type: "number" });
    expect(convexValidatorToJsonSchema(v.boolean())).toEqual({
      type: "boolean",
    });
    expect(convexValidatorToJsonSchema(v.null())).toEqual({ type: "null" });
    expect(convexValidatorToJsonSchema(v.any())).toEqual({});
  });

  test("int64 surfaces as JSON integer with int64 format", () => {
    expect(convexValidatorToJsonSchema(v.int64())).toEqual({
      type: "integer",
      format: "int64",
    });
  });

  test("bytes maps to base64-encoded string", () => {
    expect(convexValidatorToJsonSchema(v.bytes())).toEqual({
      type: "string",
      contentEncoding: "base64",
    });
  });

  test("literal becomes a const schema", () => {
    expect(convexValidatorToJsonSchema(v.literal("open"))).toEqual({
      const: "open",
    });
  });

  test("union becomes anyOf", () => {
    expect(
      convexValidatorToJsonSchema(v.union(v.literal("open"), v.literal("paid"))),
    ).toEqual({
      anyOf: [{ const: "open" }, { const: "paid" }],
    });
  });

  test("array becomes typed array schema", () => {
    expect(convexValidatorToJsonSchema(v.array(v.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("id carries the table name as a JSON-Schema extension", () => {
    expect(convexValidatorToJsonSchema(v.id("invoices"))).toEqual({
      type: "string",
      format: "convex-id",
      "x-convex-table": "invoices",
    });
  });

  test("PropertyValidators record becomes an object schema with required[]", () => {
    const schema = propertyValidatorsToObjectSchema({
      status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
      limit: v.number(),
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        status: { anyOf: [{ const: "open" }, { const: "paid" }] },
        limit: { type: "number" },
      },
      required: ["limit"],
      additionalProperties: false,
    });
  });

  test("PropertyValidators with only optional fields omits required[]", () => {
    const schema = propertyValidatorsToObjectSchema({
      status: v.optional(v.string()),
    });

    expect(schema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("record becomes an object with additionalProperties schema", () => {
    expect(
      convexValidatorToJsonSchema(v.record(v.string(), v.number())),
    ).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  test("nested object validator recurses through fields", () => {
    expect(
      convexValidatorToJsonSchema(
        v.object({
          inner: v.object({
            x: v.number(),
            y: v.optional(v.string()),
          }),
        }),
      ),
    ).toEqual({
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "string" },
          },
          required: ["x"],
          additionalProperties: false,
        },
      },
      required: ["inner"],
      additionalProperties: false,
    });
  });
});
