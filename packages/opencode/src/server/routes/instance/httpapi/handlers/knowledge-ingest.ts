import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { IngestService } from "@/knowledge/ingest"
import { KnowledgeApi } from "../groups/knowledge"

export const KnowledgeIngestHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.ingest",
  (handlers) =>
    Effect.gen(function* () {
      const ingest = yield* IngestService
      return handlers.handle(
        "ingest",
        Effect.fn(function* (ctx: any) {
          const identity = yield* ExternalIdentity
          if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
          const data = yield* ingest
            .ingest({
              workspaceId: ctx.payload.workspaceId,
              identity,
              documents: ctx.payload.documents,
            })
            .pipe(Effect.catchTag("IngestForbiddenError", () => Effect.succeed(null)))
          if (data === null) return HttpServerResponse.empty({ status: 403 })
          return { code: 200, data }
        }),
      )
    }),
)
