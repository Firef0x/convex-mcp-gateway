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
    audit: {
      listEntries: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          outcome?: "allowed" | "denied" | "error";
          toolName?: string;
        },
        Array<{
          _creationTime: number;
          _id: string;
          args: any;
          durationMs: number;
          errorCode?: number;
          errorMessage?: string;
          identitySubject: string | null;
          outcome: "allowed" | "denied" | "error";
          toolKind: "query" | "mutation" | "action";
          toolName: string;
        }>,
        Name
      >;
      recordEntry: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          durationMs: number;
          errorCode?: number;
          errorMessage?: string;
          identitySubject: string | null;
          outcome: "allowed" | "denied" | "error";
          toolKind: "query" | "mutation" | "action";
          toolName: string;
        },
        string,
        Name
      >;
    };
    dispatch: {
      callTool: FunctionReference<
        "action",
        "internal",
        { args: any; name: string },
        | { data: any; ok: true }
        | { error: { code: number; message: string }; ok: false },
        Name
      >;
      listVisibleTools: FunctionReference<
        "action",
        "internal",
        {},
        Array<{
          description: string;
          inputSchema: any;
          kind: "query" | "mutation" | "action";
          name: string;
        }>,
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
      getOAuthConfig: FunctionReference<
        "query",
        "internal",
        {},
        { authServerUrl: string; resourceUrl: string | null } | null,
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
          metadata?: any;
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
          metadata?: any;
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
          metadata?: any;
          name: string;
        },
        string,
        Name
      >;
      replaceTools: FunctionReference<
        "mutation",
        "internal",
        {
          tools: Array<{
            description: string;
            functionHandle: string;
            inputSchema: any;
            kind: "query" | "mutation" | "action";
            metadata?: any;
            name: string;
          }>;
        },
        null,
        Name
      >;
      setAuthorizer: FunctionReference<
        "mutation",
        "internal",
        { authorizerHandle: string | null },
        null,
        Name
      >;
      setOAuthConfig: FunctionReference<
        "mutation",
        "internal",
        { authServerUrl: string | null; resourceUrl?: string | null },
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
