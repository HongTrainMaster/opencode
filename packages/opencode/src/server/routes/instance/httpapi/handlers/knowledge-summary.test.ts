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
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService } from "@/knowledge/ingest-job"
import { WikiSessionService } from "@/knowledge/wiki-session"
import { SummaryWriter } from "@/knowledge/summary-writer"
import { PptJobService } from "@/knowledge/ppt-job"
import { PptGenService } from "@/knowledge/ppt-gen"
import { PptCoverService } from "@/knowledge/ppt-cover"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    get: () => Effect.fail(new SessionV2.NotFoundError({ sessionID: SessionV2.ID.make("x") })),
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

// ---- 每个测试独立 tmpdir（写摘要不串数据）----
// SummaryWriter.test(root) 把 root 当作目标目录根；请求里的 llmPath 与它保持一致，
// 这样 writer 写到的 wiki/sources 与 handler 读取的路径是同一个。
const summaryDir = mkdtempSync(join(tmpdir(), "summary-test-"))
const llmPath = join(summaryDir, "kb_1")
const summaryWriterLayer = SummaryWriter.test(llmPath)
const pptGenLayer = PptGenService.test(() =>
  Effect.succeed({ status: "SUCCESS" as const, outputPath: "/tmp/o.pptx" }),
)
const pptCoverLayer = PptCoverService.test(() =>
  Effect.succeed({ status: "SUCCESS" as const, outputPath: "/tmp/o.pptx" }),
)

const graphStoreLayer = KnowledgeGraphStore.test(":memory:")
const extractorLayer = EntityExtractor.test(({ title }) =>
  Effect.succeed({ entities: [{ name: title, type: "文档" }], relations: [] }),
)
const wikiSessionLayer = WikiSessionService.test(() => Effect.succeed({ status: "SUCCESS" as const }))

// KnowledgeApi 含 session + ingest + graph + summary 四个 group，须提供全部四个 handler
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
        Layer.provide(extractorLayer),
        Layer.provide(wikiSessionLayer),
        Layer.provide(summaryWriterLayer),
      ),
    ),
    Layer.provide(IngestJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provideMerge(PptJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provide(summaryWriterLayer),
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

describe("Knowledge Summary HttpApi", () => {
  it.live("reads a missing summary as exists=false", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/serve/api/summary")
        .pipe(HttpClientRequest.setUrl(`/serve/api/summary?llmPath=${encodeURIComponent(llmPath)}&documentId=10001`), HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.exists).toBe(false)
      expect(body.content).toBeNull()
    }),
  )

  it.live("writes and then reads back the summary", () =>
    Effect.gen(function* () {
      const writeResp = yield* HttpClientRequest.post("/serve/api/summary").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            llmPath,
            documentId: "10001",
            title: "考勤制度",
            markdown: "# 考勤制度\n\n> 一句话核心观点\n\n## 核心观点\n\n- 要点一",
          }),
        ),
        HttpClient.execute,
      )
      expect(writeResp.status).toBe(200)
      const writeBody = (yield* writeResp.json) as any
      expect(writeBody.documentId).toBe("10001")
      expect(writeBody.status).toBe("SUCCESS")

      const readResp = yield* HttpClientRequest.get("/serve/api/summary")
        .pipe(HttpClientRequest.setUrl(`/serve/api/summary?llmPath=${encodeURIComponent(llmPath)}&documentId=10001`), HttpClient.execute)
      const readBody = (yield* readResp.json) as any
      expect(readBody.exists).toBe(true)
      expect(readBody.content).toContain("一句话核心观点")
      expect(readBody.content).toContain("type: summary") // frontmatter 由 SummaryWriter 补
    }),
  )

  it.live("overwrites an existing summary", () =>
    Effect.gen(function* () {
      yield* HttpClientRequest.post("/serve/api/summary").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({ llmPath, documentId: "10001", title: "考勤制度", markdown: "旧版" }),
        ),
        HttpClient.execute,
      )
      const resp = yield* HttpClientRequest.post("/serve/api/summary").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({ llmPath, documentId: "10001", title: "考勤制度", markdown: "新版" }),
        ),
        HttpClient.execute,
      )
      const body = (yield* resp.json) as any
      expect(body.status).toBe("SUCCESS")
      const file = readFileSync(join(llmPath, "wiki", "sources", "10001.md"), "utf-8")
      expect(file).toContain("新版")
      expect(file).not.toContain("旧版")
    }),
  )

  it.live("sanitizes documentId against path traversal", () =>
    Effect.gen(function* () {
      const resp = yield* HttpClientRequest.post("/serve/api/summary").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({ llmPath, documentId: "../evil", title: "t", markdown: "x" }),
        ),
        HttpClient.execute,
      )
      expect(resp.status).toBe(200)
      const body = (yield* resp.json) as any
      expect(body.status).toBe("SUCCESS")
      // sanitizeDocumentId("../evil") → "___evil"（. 与 / 都替换为 _）；不会写到 llmPath 之外的目录
      expect(existsSync(join(llmPath, "wiki", "sources", "___evil.md"))).toBe(true)
    }),
  )
})
