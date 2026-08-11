import { SessionV2, SessionSchema } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { VirtualWorkspaceResolver } from "@opencode-ai/core/virtual-workspace"
import { KnowledgeApi } from "../groups/knowledge"
import { mkdirSync } from "fs"

export const KnowledgeSessionHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.session",
  (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      return handlers
        .handle(
          "list",
          Effect.fn(function* (ctx) {
            const identity = yield* ExternalIdentity
            // 未认证用户不返回任何会话
            if (!identity.userId) return { data: [] }
            const workspace = identity.workspaces.find(
              (w) => w.workspaceId === ctx.query.workspaceId,
            )
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.query.workspaceId,
              workspace?.llmPath,
            )
            const sessions = yield* session.list({
              directory: workspaceRef.directory,
              limit: ctx.query.limit ?? 50,
              // 与原生 session.list 一致：SQL 层按用户严格过滤（LIMIT 之前）。
              externalUser: { userId: identity.userId, tenantId: identity.tenantId },
            }).pipe(
              Effect.catchCause(() => Effect.succeed([] as Array<any>)),
            )
            yield* Effect.logInfo("knowledge.session.list", {
              userId: identity.userId,
              tenantId: identity.tenantId,
              workspaceId: ctx.query.workspaceId,
              directory: workspaceRef.directory,
              limit: ctx.query.limit ?? 50,
              returned: sessions.length,
            })
            return { data: sessions.map((s) => JSON.parse(JSON.stringify(s))) }
          }),
        )
        .handle(
          "create",
          Effect.fn(function* (ctx) {
            const identity = yield* ExternalIdentity
            // 未认证用户不允许创建会话
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const workspace = identity.workspaces.find(
              (w) => w.workspaceId === ctx.payload.workspaceId,
            )
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.payload.workspaceId,
              workspace?.llmPath,
            )
            // Ensure the virtual directory exists on disk so downstream location
            // services (FileSystem, Config, etc.) can resolve it without 500.
            yield* Effect.sync(() => mkdirSync(workspaceRef.directory, { recursive: true }))
            const created = yield* session.create({
              location: { directory: workspaceRef.directory },
              metadata: {
                externalTenantId: identity.tenantId,
                externalUserId: identity.userId,
                externalNickName: identity.nickName,
                externalWorkspaceId: ctx.payload.workspaceId,
              },
            }).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            )
            if (!created) {
              return HttpServerResponse.empty({ status: 500 })
            }
            return { data: JSON.parse(JSON.stringify(created)) }
          }),
        )
        .handle(
          "workspaces",
          Effect.fn(function* () {
            const identity = yield* ExternalIdentity
            const wss: any[] = (identity as any).workspaces ?? []
            const result = wss.map((w: any) => ({
              ...w,
              directory: VirtualWorkspaceResolver.resolve(
                identity,
                w.workspaceId,
                w.llmPath,
              ).directory,
            }))
            return { data: JSON.parse(JSON.stringify(result)) }
          }),
        )
    }),
)
