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
            // NumberFromString 解析出的 hops 是 number；仅允许 1|2，否则 400
            const rawHops = ctx.query.hops ?? 1
            if (rawHops !== 1 && rawHops !== 2) return HttpServerResponse.empty({ status: 400 })
            const data = yield* store.listRelationsForEntity({
              entityId: ctx.query.entityId,
              userId: identity.userId,
              hops: rawHops as 1 | 2,
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
