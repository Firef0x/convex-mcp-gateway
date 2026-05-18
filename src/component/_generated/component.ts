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
      pruneOlderThan: FunctionReference<
        "mutation",
        "internal",
        { cutoffMs: number },
        number,
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
      recordAuthDenial: FunctionReference<
        "mutation",
        "internal",
        {
          args: any;
          auditIdentitySubject: string | null;
          durationMs: number;
          errorCode: number;
          errorMessage: string;
          name: string;
          outcome: "denied" | "error";
        },
        null,
        Name
      >;
      runTool: FunctionReference<
        "action",
        "internal",
        { args: any; auditIdentitySubject: string | null; name: string },
        | { data: any; ok: true }
        | { error: { code: number; message: string }; ok: false },
        Name
      >;
    };
    registry: {
      clearAllTools: FunctionReference<"mutation", "internal", {}, null, Name>;
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
          outputSchema?: any;
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
          outputSchema?: any;
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
          outputSchema?: any;
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
            outputSchema?: any;
          }>;
        },
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
    sessions: {
      createSession: FunctionReference<
        "mutation",
        "internal",
        {
          identitySubject: string | null;
          protocolVersion: string;
          sessionId: string;
        },
        string,
        Name
      >;
      deleteSession: FunctionReference<
        "mutation",
        "internal",
        { callerIdentitySubject: string | null; sessionId: string },
        "deleted" | "not_found" | "forbidden",
        Name
      >;
      getSession: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        {
          _creationTime: number;
          _id: string;
          createdAt: number;
          identitySubject?: string | null;
          lastSeenAt: number;
          protocolVersion: string;
          sessionId: string;
        } | null,
        Name
      >;
      pruneSessions: FunctionReference<
        "mutation",
        "internal",
        { olderThanMs: number },
        number,
        Name
      >;
      touchSession: FunctionReference<
        "mutation",
        "internal",
        { sessionId: string },
        boolean,
        Name
      >;
    };
  };
