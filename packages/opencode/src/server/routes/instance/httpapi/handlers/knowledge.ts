import { SessionV2, SessionSchema } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { VirtualWorkspaceResolver } from "@opencode-ai/core/virtual-workspace"
import { KnowledgeApi } from "../groups/knowledge"

export const KnowledgeSessionHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.session",
  (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const identity = yield* ExternalIdentity

      return handlers
        .handle(
          "list",
          Effect.fn(function* (ctx) {
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.query.workspaceId,
            )
            const sessions = yield* session.list({
              directory: workspaceRef.directory,
              limit: ctx.query.limit ?? 50,
            })
            // Filter by external identity metadata
            const filtered = sessions.filter(
              (s) =>
                s.metadata?.externalUserId === identity.userId &&
                s.metadata?.externalTenantId === identity.tenantId,
            )
            return { data: filtered }
          }),
        )
        .handle(
          "get",
          Effect.fn(function* (ctx) {
            const maybeSession = yield* session
              .get(ctx.params.id as SessionSchema.ID)
              .pipe(
                Effect.catchTag("Session.NotFoundError", () =>
                  Effect.succeed(null),
                ),
              )
            if (
              !maybeSession ||
              maybeSession.metadata?.externalUserId !== identity.userId ||
              maybeSession.metadata?.externalTenantId !== identity.tenantId
            ) {
              return HttpServerResponse.empty({ status: 404 })
            }
            return { data: maybeSession }
          }),
        )
        .handle(
          "create",
          Effect.fn(function* (ctx) {
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.payload.workspaceId,
            )
            const created = yield* session.create({
              location: { directory: workspaceRef.directory },
              metadata: {
                externalTenantId: identity.tenantId,
                externalUserId: identity.userId,
                externalNickName: identity.nickName,
                externalWorkspaceId: ctx.payload.workspaceId,
              },
            })
            return { data: created }
          }),
        )
        .handle(
          "workspaces",
          Effect.fn(function* () {
            return { data: identity.workspaces }
          }),
        )
    }),
)
