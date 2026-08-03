import { Context, Effect, Layer, Schema } from "effect"
import type { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { parseDocument } from "./doc-parser"
import { EntityExtractor } from "./entity-extractor"
import { KnowledgeGraphStore } from "./store"

export class IngestForbiddenError extends Schema.TaggedErrorClass<IngestForbiddenError>()(
  "IngestForbiddenError",
  { message: Schema.String },
) {}

export interface IngestDocumentInput {
  documentId: string
  title: string
  categoryId?: string
  llmPath?: string
  secretLevel?: string
  format?: string
  summary?: string
  keywords?: string[]
  operation: "CREATE" | "UPDATE" | "DELETE"
  fileContent?: string
}

export interface IngestDocumentResult {
  documentId: string
  status: "SUCCESS" | "FAILED"
  entities: number
  relations: number
  error?: string
}

export interface IngestServiceShape {
  readonly ingest: (args: {
    workspaceId: string
    identity: ExternalIdentityInfo
    documents: IngestDocumentInput[]
  }) => Effect.Effect<IngestDocumentResult[], IngestForbiddenError>
}

export class IngestService extends Context.Service<IngestService, IngestServiceShape>()(
  "@opencode/knowledge/Ingest",
) {
  static layer = Layer.effect(
    IngestService,
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      const extractor = yield* EntityExtractor
      return IngestService.of({
        ingest: (args) =>
          Effect.gen(function* () {
            yield* assertWorkspaceAllowed(args.identity, args.workspaceId)
            const scope: "PUBLIC" | "PRIVATE" = args.workspaceId.startsWith("my_") ? "PRIVATE" : "PUBLIC"
            const ownerId = scope === "PRIVATE" ? args.identity.userId : ""

            const ingestOne = (doc: IngestDocumentInput): Effect.Effect<IngestDocumentResult> =>
              Effect.gen(function* () {
                if (doc.operation === "DELETE") {
                  const deleted = yield* store.deleteDocumentGraph({
                    workspaceId: args.workspaceId,
                    documentId: doc.documentId,
                  })
                  return {
                    documentId: doc.documentId,
                    status: "SUCCESS",
                    entities: deleted.deletedEntities,
                    relations: deleted.deletedRelations,
                  }
                }
                const parsed = yield* parseDocument({ format: doc.format ?? "", fileContent: doc.fileContent })
                const extracted = yield* extractor.extract({ title: doc.title, text: parsed.text })
                const result = yield* store.replaceDocumentGraph({
                  workspaceId: args.workspaceId,
                  documentId: doc.documentId,
                  scope,
                  ownerId,
                  entities: extracted.entities,
                  relations: extracted.relations,
                })
                return {
                  documentId: doc.documentId,
                  status: "SUCCESS",
                  entities: result.entityCount,
                  relations: result.relationCount,
                }
              })

            return yield* Effect.forEach(
              args.documents,
              (doc) =>
                ingestOne(doc).pipe(
                  // NOTE: Effect 4.0.0-beta.83 renamed catchAll to catch (same semantics)
                  Effect.catch((error) =>
                    Effect.succeed({
                      documentId: doc.documentId,
                      status: "FAILED" as const,
                      entities: 0,
                      relations: 0,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  ),
                ),
              { concurrency: 2 },
            )
          }),
      })
    }),
  )
}

function assertWorkspaceAllowed(
  identity: ExternalIdentityInfo,
  workspaceId: string,
): Effect.Effect<void, IngestForbiddenError> {
  // 自己的个人工作区总是放行（即使 getKnowledge 尚未返回）
  if (workspaceId === `my_${identity.userId}`) return Effect.void
  const ws = identity.workspaces.find((w) => w.workspaceId === workspaceId)
  if (!ws) {
    return Effect.fail(new IngestForbiddenError({ message: `workspace ${workspaceId} is not accessible to this user` }))
  }
  if (workspaceId.startsWith("my_")) {
    return Effect.fail(new IngestForbiddenError({ message: "forbidden personal workspace" }))
  }
  return Effect.void
}
