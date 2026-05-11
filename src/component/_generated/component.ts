/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    dispatch: {
      callTool: FunctionReference<
        "action",
        "internal",
        { args: any; name: string },
        | { data: any; ok: true }
        | { error: { code: number; message: string }; ok: false },
        Name
      >;
    };
    registry: {
      clearAll: FunctionReference<"mutation", "internal", {}, null, Name>;
      getAuthorizer: FunctionReference<
        "query",
        "internal",
        {},
        string | null,
        Name
      >;
      getTool: FunctionReference<
        "query",
        "internal",
        { name: string },
        {
          _creationTime: number;
          _id: string;
          description: string;
          functionHandle: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          name: string;
        } | null,
        Name
      >;
      listTools: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          description: string;
          functionHandle: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          name: string;
        }>,
        Name
      >;
      registerTool: FunctionReference<
        "mutation",
        "internal",
        {
          description: string;
          functionHandle: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          name: string;
        },
        string,
        Name
      >;
      setAuthorizer: FunctionReference<
        "mutation",
        "internal",
        { authorizerHandle: string | null },
        null,
        Name
      >;
      unregisterTool: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        boolean,
        Name
      >;
    };
  };
