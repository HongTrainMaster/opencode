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
import { KnowledgeSummaryHandler } from "./knowledge-summary"
import { KnowledgeGraphStore } from "@/knowledge/store"
import { EntityExtractor } from "@/knowledge/entity-extractor"
import { SummaryWriter } from "@/knowledge/summary-writer"
import { WikiSessionService } from "@/knowledge/wiki-session"
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService, type IngestJobServiceShape } from "@/knowledge/ingest-job"
import { testEffect } from "@test/lib/effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  workspaces: [{ workspaceId: "ws_1", workspaceName: "Workspace 1", llmPath: tmpdir(), categories: [] }],
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
// wiki 会话 mock：SUCCESS + 真实存在的源页路径（入库管线会把它落盘为 {documentId}.md）
const wikiSourcePage = (() => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-mock-"))
  const p = join(dir, "source.md")
  writeFileSync(p, "# 考勤制度\n\n## 核心观点\n\n- 要点一", "utf-8")
  return p
})()
const wikiSessionLayer = WikiSessionService.test(() =>
  Effect.succeed({ status: "SUCCESS" as const, sourcePath: wikiSourcePage }),
)
const summaryWriterLayer = SummaryWriter.test(tmpdir())

// ---- 组装 KnowledgeApi（session + ingest 两个 group）----
const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(KnowledgeSummaryHandler),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(graphStoreLayer),
        Layer.provide(extractorLayer),
        Layer.provide(wikiSessionLayer),
        Layer.provide(summaryWriterLayer),
      ),
    ),
    Layer.provideMerge(IngestJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provide([schemaErrorLayer, mockExternalAuthLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<never>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(graphStoreLayer),
  Layer.provideMerge(summaryWriterLayer),
  Layer.provideMerge(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(mockSessionLayer),
  Layer.provide(mockIdentityLayer),
)
const it = testEffect(apiLayer)

/** 轮询 job 直到终态 */
const pollJobUntilDone = (jobService: IngestJobServiceShape, jobId: string, attempts = 50): Effect.Effect<any, unknown, never> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const job = yield* jobService.get(jobId)
      if (job && job.status !== "RUNNING") return job
      yield* Effect.sleep("10 millis")
    }
    throw new Error("timed out waiting for ingest job")
  })

describe("Knowledge Ingest HttpApi", () => {
  it.live("submits a document via POST /serve/api/ingest and resolves job to SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* IngestJobService
      const response = yield* HttpClientRequest.post("/serve/api/ingest").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            workspaceId: "ws_1",
            documents: [
              {
                documentId: "10001",
                title: "考勤制度",
                llmPath: tmpdir(),
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
      expect(body.data[0].jobId).toBeTruthy()
      expect(body.data[0].status).toBe("RUNNING")
      // 轮询 job 到终态
      const job = yield* pollJobUntilDone(jobService, body.data[0].jobId)
      expect(job.status).toBe("SUCCESS")
      expect(job.entities).toBe(2)
      expect(job.relations).toBe(1)
      expect(job.summary).toBe("SUCCESS")
    }),
  )

  it.live("GET /serve/api/ingest/jobs/:jobId returns the job status", () =>
    Effect.gen(function* () {
      const jobService = yield* IngestJobService
      const jobId = yield* jobService.start({
        documentId: "10001",
        workspaceId: "ws_1",
        operation: "CREATE",
        run: Effect.succeed({ entities: 2, relations: 1, summary: "SUCCESS" }),
      })
      yield* pollJobUntilDone(jobService, jobId)
      const response = yield* HttpClientRequest.get(`/serve/api/ingest/jobs/${jobId}`).pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.code).toBe(200)
      expect(body.data.jobId).toBe(jobId)
      expect(body.data.status).toBe("SUCCESS")
      expect(body.data.entities).toBe(2)
    }),
  )

  it.live("GET /serve/api/ingest/jobs/:jobId returns 404 for unknown job", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/serve/api/ingest/jobs/job_unknown").pipe(
        HttpClient.execute,
      )
      expect(response.status).toBe(404)
    }),
  )

  it.live("GET /serve/api/ingest/jobs?ids= returns jobs in input order", () =>
    Effect.gen(function* () {
      const jobService = yield* IngestJobService
      const id1 = yield* jobService.start({
        documentId: "1",
        workspaceId: "ws_1",
        operation: "CREATE",
        run: Effect.succeed({ entities: 1, relations: 0, summary: null }),
      })
      const id2 = yield* jobService.start({
        documentId: "2",
        workspaceId: "ws_1",
        operation: "DELETE",
        run: Effect.succeed({ entities: 0, relations: 0, summary: null }),
      })
      yield* pollJobUntilDone(jobService, id1)
      yield* pollJobUntilDone(jobService, id2)
      const response = yield* HttpClientRequest.get(
        `/serve/api/ingest/jobs?ids=${id1},${id2}`,
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data).toHaveLength(2)
      expect(body.data[0].jobId).toBe(id1)
      expect(body.data[1].jobId).toBe(id2)
    }),
  )

  it.live("accepts a workspace not in the identity (skips workspace check)", () =>
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
      // 入库跳过工作区校验，直接信任 documents 携带的 llmPath
      expect(response.status).toBe(200)
    }),
  )

  it.live("ingest DELETE removes existing graph", () =>
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      const jobService = yield* IngestJobService
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
      yield* pollJobUntilDone(jobService, body.data[0].jobId)
      const remaining = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
      expect(remaining).toHaveLength(0)
    }),
  )
})
