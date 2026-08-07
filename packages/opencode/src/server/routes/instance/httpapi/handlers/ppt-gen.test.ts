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
import { PptGenHandler } from "./ppt-gen"
import { KnowledgeGraphStore } from "@/knowledge/store"
import { EntityExtractor } from "@/knowledge/entity-extractor"
import { SummaryWriter } from "@/knowledge/summary-writer"
import { WikiSessionService } from "@/knowledge/wiki-session"
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService } from "@/knowledge/ingest-job"
import { PptJobService } from "@/knowledge/ppt-job"
import { PptGenService } from "@/knowledge/ppt-gen"
import { PptCoverService } from "@/knowledge/ppt-cover"
import { testEffect } from "@test/lib/effect"
import { writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---- mock session（复刻自 knowledge-ingest.test.ts）----
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
  workspaces: [{ workspaceId: "ws_1", workspaceName: "Workspace 1", llmPath: "/tmp", categories: [] }],
  permissions: {},
})
const mockExternalAuthLayer = Layer.succeed(ExternalAuth, ExternalAuth.of((effect: any) => effect))
const mockIdentityLayer = Layer.succeed(ExternalIdentity, testIdentity)
const graphStoreLayer = KnowledgeGraphStore.test(":memory:")
const summaryWriterLayer = SummaryWriter.test(tmpdir())

// 真实 PptJobService（内存 store）+ 注入 PptGenService 测试实现（真实跑 build.py 太慢，这里直接给 SUCCESS）
const tmpOut = join(tmpdir(), "ppt-gen-test-output.pptx")
const pptGenLayer = PptGenService.test(() =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      mkdirSync(tmpdir(), { recursive: true })
      writeFileSync(tmpOut, Buffer.from("FAKE-PPTX"))
    })
    return { status: "SUCCESS" as const, outputPath: tmpOut }
  }),
)
const pptCoverLayer = PptCoverService.test(() =>
  Effect.succeed({ status: "SUCCESS" as const, outputPath: tmpOut }),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(KnowledgeSummaryHandler),
    Layer.provide(PptGenHandler),
    Layer.provide(pptGenLayer),
    Layer.provide(pptCoverLayer),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(graphStoreLayer),
        Layer.provide(EntityExtractor.test(({ title }) => Effect.succeed({ entities: [], relations: [] }))),
        Layer.provide(summaryWriterLayer),
        Layer.provide(WikiSessionService.test(() => Effect.succeed({ status: "SUCCESS" as const, sourcePath: "" }))),
      ),
    ),
    Layer.provideMerge(IngestJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provideMerge(PptJobService.layer.pipe(Layer.provide(graphStoreLayer))),
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

describe("Knowledge Ppt HttpApi", () => {
  it.live("submits a ppt gen task via POST /serve/api/ppt/gen and resolves to SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const response = yield* HttpClientRequest.post("/serve/api/ppt/gen").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            taskId: "ppt_10001",
            prompt: "做一个公司介绍",
            style: {
              fileName: "template.pptx",
              fileContent: Buffer.from("stub").toString("base64"),
            },
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.code).toBe(200)
      expect(body.data[0].taskId).toBe("ppt_10001")
      expect(body.data[0].status).toBe("RUNNING")
      expect(body.data[0].jobId).toBeTruthy()
      const jobId = body.data[0].jobId
      // 轮询终态
      let job: any
      for (let i = 0; i < 100; i++) {
        job = yield* jobService.get(jobId)
        if (job && job.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      expect(job?.status).toBe("SUCCESS")
      expect(job?.outputPath).toBe(tmpOut)
    }),
  )

  it.live("GET /serve/api/ppt/jobs/:jobId returns the job status", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const jobId = yield* jobService.start({
        taskId: "ppt_2",
        prompt: "x",
        run: Effect.succeed({ outputPath: "/tmp/o.pptx" }),
      })
      for (let i = 0; i < 100; i++) {
        const j = yield* jobService.get(jobId)
        if (j && j.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      const response = yield* HttpClientRequest.get(`/serve/api/ppt/jobs/${jobId}`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data.taskId).toBe("ppt_2")
      expect(body.data.status).toBe("SUCCESS")
    }),
  )

  it.live("GET /serve/api/ppt/file/:jobId returns bytes when SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const jobId = yield* jobService.start({
        taskId: "ppt_3",
        prompt: "x",
        run: Effect.succeed({ outputPath: tmpOut }),
      })
      for (let i = 0; i < 100; i++) {
        const j = yield* jobService.get(jobId)
        if (j && j.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      const response = yield* HttpClientRequest.get(`/serve/api/ppt/file/${jobId}`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = yield* response.text
      expect(body).toBe("FAKE-PPTX")
    }),
  )

  it.live("GET /serve/api/ppt/file/:jobId returns 404 for unknown job", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/serve/api/ppt/file/job_unknown").pipe(HttpClient.execute)
      expect(response.status).toBe(404)
    }),
  )

  it.live("POST /serve/api/ppt/render-cover 提交并轮询到 SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const response = yield* HttpClientRequest.post("/serve/api/ppt/render-cover").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            taskId: "cover_10001",
            style: { fileName: "template.pptx", fileContent: Buffer.from("stub").toString("base64") },
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.code).toBe(200)
      expect(body.data[0].taskId).toBe("cover_10001")
      expect(body.data[0].status).toBe("RUNNING")
      const jobId = body.data[0].jobId
      let job: any
      for (let i = 0; i < 100; i++) {
        job = yield* jobService.get(jobId)
        if (job && job.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      expect(job?.status).toBe("SUCCESS")
    }),
  )
})
