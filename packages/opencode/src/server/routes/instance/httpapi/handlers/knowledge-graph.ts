import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { KnowledgeGraphStore } from "@/knowledge/store"
import { KnowledgeApi } from "../groups/knowledge"

export const KnowledgeGraphHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.graph",
  (handlers) =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      return handlers
        .handle(
          "entities",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const data = yield* store.listEntitiesByDocument({
              documentId: ctx.query.documentId,
              userId: identity.userId,
            })
            return { data }
          }),
        )
        .handle(
          "relations",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            // NumberFromString 解析出的 hops 是 number，store 签名要求 1|2，此处收敛
            const hops = (ctx.query.hops as 1 | 2 | undefined) ?? 1
            const data = yield* store.listRelationsForEntity({
              entityId: ctx.query.entityId,
              userId: identity.userId,
              hops,
            })
            return { data }
          }),
        )
        .handle(
          "entity",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const data = yield* store.getEntity({ entityId: ctx.params.id, userId: identity.userId })
            if (!data) return HttpServerResponse.empty({ status: 404 })
            return { data }
          }),
        )
    }),
)
