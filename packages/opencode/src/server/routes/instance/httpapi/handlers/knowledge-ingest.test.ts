import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { ExternalIdentity, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { SessionV2, SessionSchema } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { schemaErrorLayer } from "../middleware/schema-error"
import { KnowledgeApi } from "../groups/knowledge"
import { KnowledgeSessionHandler } from "./knowledge"
import { KnowledgeIngestHandler } from "./knowledge-ingest"
import { KnowledgeGraphHandler } from "./knowledge-graph"
import { KnowledgeGraphStore } from "@/knowledge/store"
import { EntityExtractor } from "@/knowledge/entity-extractor"
import { SummaryGenerator } from "@/knowledge/summary-generator"
import { SummaryWriter } from "@/knowledge/summary-writer"
import { IngestService } from "@/knowledge/ingest"
import { testEffect } from "@test/lib/effect"
import { tmpdir } from "node:os"

// ---- mock session（从 knowledge.test.ts 复刻）----
const now = DateTime.makeUnsafe(Date.now())
const mockSessionOwned = SessionSchema.Info.make({
  id: SessionV2.ID.make("ses_owned"),
  projectID: ProjectV2.ID.make("prj_test"),
  title: "My Session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: AbsolutePath.make("/virtual/test") },
  metadata: { externalUserId: "user_1", externalTenantId: "tenant_01" },
})
const mockSessionLayer = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    list: () => Effect.succeed([mockSessionOwned]),
    get: (id) =>
      id === "ses_owned"
        ? Effect.succeed(mockSessionOwned)
        : Effect.fail(new SessionV2.NotFoundError({ sessionID: id })),
    create: () => Effect.succeed(mockSessionOwned),
    messages: () => Effect.die("not implemented") as any,
    message: () => Effect.die("not implemented") as any,
    context: () => Effect.die("not implemented") as any,
    events: () => Effect.die("not implemented") as any,
    history: () => Effect.die("not implemented") as any,
    switchAgent: () => Effect.die("not implemented") as any,
    switchModel: () => Effect.die("not implemented") as any,
    prompt: () => Effect.die("not implemented") as any,
    shell: () => Effect.die("not implemented") as any,
    skill: () => Effect.die("not implemented") as any,
    compact: () => Effect.die("not implemented") as any,
    wait: () => Effect.die("not implemented") as any,
    resume: () => Effect.die("not implemented") as any,
    interrupt: () => Effect.die("not implemented") as any,
    revert: {
      stage: () => Effect.die("not implemented") as any,
      clear: () => Effect.die("not implemented") as any,
      commit: () => Effect.die("not implemented") as any,
    },
    active: Effect.die("not implemented") as any,
  }),
)

// ---- 身份 ----
const testIdentity = ExternalIdentityInfo.make({
  userId: "user_1",
  nickName: "Test User",
  tenantId: "tenant_01",
  workspaces: [{ workspaceId: "ws_1", workspaceName: "Workspace 1", categories: [] }],
  permissions: {},
})
const mockExternalAuthLayer = Layer.succeed(ExternalAuth, ExternalAuth.of((effect: any) => effect))
const mockIdentityLayer = Layer.succeed(ExternalIdentity, testIdentity)

// ---- 共享 store 实例：handler 与测试体解析到同一个 KnowledgeGraphStore ----
const graphStoreLayer = KnowledgeGraphStore.test(":memory:")
const extractorLayer = EntityExtractor.test(({ title }) =>
  Effect.succeed({
    entities: [
      { name: title, type: "文档" },
      { name: "人力资源部", type: "角色" },
    ],
    relations: [{ head: title, tail: "人力资源部", relation: "负责" }],
  }),
)
const summaryGeneratorLayer = SummaryGenerator.test(() => Effect.succeed({ kind: "skipped" }))
const summaryWriterLayer = SummaryWriter.test(tmpdir())

// ---- 组装 KnowledgeApi（session + ingest 两个 group）----
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(graphStoreLayer),
        Layer.provide(extractorLayer),
        Layer.provide(summaryGeneratorLayer),
        Layer.provide(summaryWriterLayer),
      ),
    ),
    Layer.provide([schemaErrorLayer, mockExternalAuthLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<never>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(graphStoreLayer),
  Layer.provideMerge(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(mockSessionLayer),
  Layer.provide(mockIdentityLayer),
)
const it = testEffect(apiLayer)

describe("Knowledge Ingest HttpApi", () => {
  it.live("ingests a document via POST /serve/api/ingest", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [
              {
                documentId: "10001",
                title: "考勤制度",
                format: "txt",
                operation: "CREATE",
                fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
              },
            ],
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.code).toBe(200)
      expect(body.data).toHaveLength(1)
      expect(body.data[0].documentId).toBe("10001")
      expect(body.data[0].status).toBe("SUCCESS")
      expect(body.data[0].entities).toBe(2)
      expect(body.data[0].relations).toBe(1)
    }),
  )

  it.live("returns 403 for a workspace the user cannot access", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "kb_forbidden",
            documents: [{ documentId: "1", title: "x", operation: "DELETE" }],
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(403)
    }),
  )

  it.live("ingest DELETE removes existing graph", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "ws_1",
        documentId: "10001",
        scope: "PUBLIC",
        ownerId: "",
        entities: [{ name: "旧制度", type: "制度" }],
        relations: [],
      })
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [{ documentId: "10001", title: "旧制度", operation: "DELETE" }],
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data[0].status).toBe("SUCCESS")
      const remaining = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      expect(remaining).toHaveLength(0)
    }),
  )
})
