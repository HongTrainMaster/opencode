import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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
import { IngestService } from "@/knowledge/ingest"
import { testEffect } from "@test/lib/effect"

// ---- mock session（复刻自 knowledge.test.ts）----
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
  Effect.succeed({ entities: [{ name: title, type: "文档" }], relations: [] }),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(graphStoreLayer),
        Layer.provide(extractorLayer),
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

describe("Knowledge Graph HttpApi", () => {
  it.live("lists entities for a document", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "ws_1",
        documentId: "10001",
        scope: "PUBLIC",
        ownerId: "",
        entities: [
          { name: "考勤制度", type: "制度" },
          { name: "人力资源部", type: "角色" },
        ],
        relations: [{ head: "考勤制度", tail: "人力资源部", relation: "负责" }],
      })
      const response = yield* HttpClientRequest.get("/serve/api/graph/entities?documentId=10001").pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data).toHaveLength(2)
      expect(body.data[0].name).toBeDefined()
    }),
  )

  it.live("lists relations for an entity (2 hops)", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "ws_1",
        documentId: "10001",
        scope: "PUBLIC",
        ownerId: "",
        entities: [
          { name: "A", type: "概念" },
          { name: "B", type: "概念" },
          { name: "C", type: "概念" },
        ],
        relations: [
          { head: "A", tail: "B", relation: "包含" },
          { head: "B", tail: "C", relation: "引用" },
        ],
      })
      const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      const a = entities.find((e) => e.name === "A")!
      const response = yield* HttpClientRequest.get(
        `/serve/api/graph/relations?entityId=${a.id}&hops=2`,
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data.map((r: any) => r.relationType).sort()).toEqual(["包含", "引用"])
    }),
  )

  it.live("returns 400 for invalid hops value", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "ws_1",
        documentId: "10001",
        scope: "PUBLIC",
        ownerId: "",
        entities: [{ name: "A", type: "概念" }],
        relations: [],
      })
      const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      const a = entities.find((e) => e.name === "A")!
      const response = yield* HttpClientRequest.get(
        `/serve/api/graph/relations?entityId=${a.id}&hops=3`,
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
    }),
  )

  it.live("gets entity detail for an owned PRIVATE entity", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "my_user_1",
        documentId: "20001",
        scope: "PRIVATE",
        ownerId: "user_1",
        entities: [{ name: "私人笔记", type: "文档" }],
        relations: [],
      })
      const owned = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
      expect(owned).toHaveLength(1)
      const detail = yield* HttpClientRequest.get(`/serve/api/graph/entity/${owned[0]!.id}`).pipe(HttpClient.execute)
      expect(detail.status).toBe(200)
      const body = (yield* detail.json) as any
      expect(body.data.name).toBe("私人笔记")
    }),
  )

  it.live("returns empty entities for private doc not owned by caller", () =>
    Effect.gen(function* () {
      // 调用者身份为 user_1（mockIdentityLayer）；写入 user_2 的私有文档，验证跨用户隔离。
      // documentId 独立（30002）避免与测试3（20001, my_user_1）在共享 :memory: store 中残留冲突。
      const store = yield* KnowledgeGraphStore
      yield* store.replaceDocumentGraph({
        workspaceId: "my_user_2",
        documentId: "30002",
        scope: "PRIVATE",
        ownerId: "user_2",
        entities: [{ name: "私人笔记", type: "文档" }],
        relations: [],
      })
      const response = yield* HttpClientRequest.get("/serve/api/graph/entities?documentId=30002").pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data).toHaveLength(0)
    }),
  )
})
