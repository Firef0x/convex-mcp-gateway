import { v } from "convex/values";
import type {
  GenericValidator,
  PropertyValidators,
  Validator,
  VAny,
  VArray,
  VBoolean,
  VBytes,
  VFloat64,
  VId,
  VInt64,
  VLiteral,
  VNull,
  VObject,
  VRecord,
  VString,
  VUnion,
} from "convex/values";

export type JsonSchema =
  | {
      type: "string";
      enum?: string[];
      format?: string;
      contentEncoding?: string;
      description?: string;
      [key: string]: unknown;
    }
  | { type: "number"; description?: string; [key: string]: unknown }
  | {
      type: "integer";
      format?: string;
      description?: string;
      [key: string]: unknown;
    }
  | { type: "boolean"; description?: string; [key: string]: unknown }
  | { type: "null"; description?: string; [key: string]: unknown }
  | {
      type: "array";
      items: JsonSchema;
      description?: string;
      [key: string]: unknown;
    }
  | {
      type: "object";
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: JsonSchema | boolean;
      description?: string;
      [key: string]: unknown;
    }
  | { const: unknown; description?: string; [key: string]: unknown }
  | { anyOf: JsonSchema[]; description?: string; [key: string]: unknown }
  | { description?: string; [key: string]: unknown };

export type McpToolKind = "query" | "mutation" | "action";

export interface McpToolDefinition {
  name: string;
  description: string;
  kind: McpToolKind;
  functionReference: unknown;
  inputSchema: JsonSchema;
}

/**
 * Argument validator object for the authorizer query.
 *
 * The host wraps a Convex `internalQuery` that uses these exact args and
 * returns `mcpAuthorizerReturns`. Use it together with the convenience type
 * `McpAuthorizerHandler` for full type inference inside the handler.
 *
 * ```ts
 * import { internalQuery } from "./_generated/server.js";
 * import {
 *   mcpAuthorizerArgs,
 *   mcpAuthorizerReturns,
 *   type McpAuthorizerHandler,
 * } from "@convex-dev/mcp-gateway";
 *
 * export const mcpAuthorize = internalQuery({
 *   args: mcpAuthorizerArgs,
 *   returns: mcpAuthorizerReturns,
 *   handler: (async (ctx, { toolName, toolKind, args }) => {
 *     const identity = await ctx.auth.getUserIdentity();
 *     if (!identity) return { allowed: false, reason: "Unauthorized" };
 *     return { allowed: true };
 *   }) satisfies McpAuthorizerHandler,
 * });
 * ```
 */
export const mcpAuthorizerArgs = {
  toolName: v.string(),
  toolKind: v.union(
    v.literal("query"),
    v.literal("mutation"),
    v.literal("action"),
  ),
  args: v.any(),
} as const;

export const mcpAuthorizerReturns = v.object({
  allowed: v.boolean(),
  reason: v.optional(v.string()),
});

export interface McpAuthorizerArgs {
  toolName: string;
  toolKind: McpToolKind;
  args: Record<string, unknown>;
}

export interface McpAuthorizerDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Type alias for an authorizer handler body. Used as a documentation hint
 * for the args + return shape; `ctx` is intentionally `any` so the alias
 * stays assignable from the host's own concrete `internalQuery` typing
 * (which has its own data model, identity shape, etc.).
 */
export type McpAuthorizerHandler = (
  ctx: any,
  args: McpAuthorizerArgs,
) => Promise<McpAuthorizerDecision> | McpAuthorizerDecision;

/**
 * Convert a Convex validator (single value or args-object) into a JSON Schema
 * fragment that satisfies MCP `tools.inputSchema`.
 *
 * MCP tools always present an object-typed input schema. If you pass a
 * `PropertyValidators` record, the result is `{ type: "object", properties, required }`.
 * If you pass a single validator, it returns that fragment unwrapped.
 */
export function convexValidatorToJsonSchema(
  validator: GenericValidator | PropertyValidators,
): JsonSchema {
  if (isValidator(validator)) {
    return validatorToSchema(validator);
  }
  return propertyValidatorsToObjectSchema(validator);
}

function isValidator(value: unknown): value is GenericValidator {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

export function propertyValidatorsToObjectSchema(
  validators: PropertyValidators,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, validator] of Object.entries(validators)) {
    const optional =
      (validator as { isOptional?: string }).isOptional === "optional";
    properties[key] = validatorToSchema(validator);
    if (!optional) {
      required.push(key);
    }
  }
  const out: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    (out as { required?: string[] }).required = required;
  }
  return out;
}

function validatorToSchema(validator: GenericValidator): JsonSchema {
  const kind = (validator as { kind: string }).kind;
  switch (kind) {
    case "string":
      return { type: "string" };
    case "float64":
      return { type: "number" };
    case "int64":
      return { type: "integer", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "bytes":
      return { type: "string", contentEncoding: "base64" };
    case "any":
      return {};
    case "id": {
      const v = validator as VId<string, "required" | "optional">;
      const tableName = (v as unknown as { tableName?: string }).tableName;
      return {
        type: "string",
        format: "convex-id",
        ...(tableName !== undefined ? { "x-convex-table": tableName } : {}),
      };
    }
    case "literal": {
      const v = validator as VLiteral<string | number | boolean, "required">;
      return { const: v.value };
    }
    case "array": {
      const v = validator as VArray<unknown, GenericValidator>;
      return { type: "array", items: validatorToSchema(v.element) };
    }
    case "object": {
      const v = validator as VObject<unknown, PropertyValidators>;
      return propertyValidatorsToObjectSchema(v.fields);
    }
    case "record": {
      const v = validator as VRecord<
        unknown,
        Validator<string, "required">,
        GenericValidator
      >;
      return {
        type: "object",
        additionalProperties: validatorToSchema(v.value),
      };
    }
    case "union": {
      const v = validator as VUnion<unknown, GenericValidator[]>;
      return { anyOf: v.members.map(validatorToSchema) };
    }
    default: {
      // exhaustive escape for forward-compat with new validator kinds
      const _exhaustive: never = kind as never;
      void _exhaustive;
      return {};
    }
  }
}

export type {
  GenericValidator,
  PropertyValidators,
  Validator,
  VAny,
  VArray,
  VBoolean,
  VBytes,
  VFloat64,
  VId,
  VInt64,
  VLiteral,
  VNull,
  VObject,
  VRecord,
  VString,
  VUnion,
};
