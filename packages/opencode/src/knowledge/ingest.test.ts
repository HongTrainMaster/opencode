import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { EntityExtractor } from "./entity-extractor"
import { IngestForbiddenError, IngestService } from "./ingest"
import { KnowledgeGraphStore } from "./store"

const identity = ExternalIdentityInfo.make({
  userId: "user_1",
  nickName: "张三",
  tenantId: "tenant_01",
  workspaces: [
    { workspaceId: "kb_1", workspaceName: "公共知识库", categories: [] },
    { workspaceId: "my_user_1", workspaceName: "个人知识库", categories: [] },
  ],
  permissions: {},
})

const storeLayer = KnowledgeGraphStore.test(":memory:")
const extractorLayer = EntityExtractor.test(({ title, text }) =>
  Effect.succeed({
    entities: [
      { name: title, type: "文档" },
      { name: "人力资源部", type: "角色" },
    ],
    relations: [{ head: title, tail: "人力资源部", relation: "负责" }],
  }),
)

const run = <A>(effect: Effect.Effect<A, IngestForbiddenError, IngestService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(IngestService.layer), Effect.provide(extractorLayer), Effect.provide(storeLayer)),
  )

describe("IngestService", () => {
  it("ingests a CREATE document and writes graph", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [
            {
              documentId: "10001",
              title: "考勤制度",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("第一章 考勤制度 人力资源部 负责 考勤 管理").toString("base64"),
            },
          ],
        })
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { res, entities }
      }),
    )
    expect(results.res).toHaveLength(1)
    expect(results.res[0]!.status).toBe("SUCCESS")
    expect(results.res[0]!.entities).toBe(2)
    expect(results.res[0]!.relations).toBe(1)
    expect(results.entities).toHaveLength(2)
  })

  it("DELETE removes the document graph", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [
            {
              documentId: "10001",
              title: "考勤制度",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("正文").toString("base64"),
            },
          ],
        })
        const res = yield* svc.ingest({
          workspaceId: "kb_1",
          identity,
          documents: [{ documentId: "10001", title: "考勤制度", operation: "DELETE" }],
        })
        const entities = yield* store.listEntitiesByDocument({ documentId: "10001", userId: "user_1" })
        return { res, entities }
      }),
    )
    expect(results.res[0]!.status).toBe("SUCCESS")
    expect(results.entities).toHaveLength(0)
  })

  it("fails with IngestForbiddenError for inaccessible workspace", async () => {
    const err = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* IngestService
        return yield* svc.ingest({
          workspaceId: "kb_other",
          identity,
          documents: [{ documentId: "1", title: "x", operation: "DELETE" }],
        })
      })
        .pipe(Effect.provide(IngestService.layer), Effect.provide(extractorLayer), Effect.provide(storeLayer))
        .pipe(Effect.flip),
    )
    expect(err).toBeInstanceOf(IngestForbiddenError)
  })

  it("allows own personal workspace even if not listed", async () => {
    const results = await run(
      Effect.gen(function* () {
        const svc = yield* IngestService
        const store = yield* KnowledgeGraphStore
        const res = yield* svc.ingest({
          workspaceId: "my_user_1",
          identity,
          documents: [
            {
              documentId: "20001",
              title: "私人笔记",
              format: "txt",
              operation: "CREATE",
              fileContent: Buffer.from("我的私人笔记内容").toString("base64"),
            },
          ],
        })
        const entities = yield* store.listEntitiesByDocument({ documentId: "20001", userId: "user_1" })
        return { res, entities }
      }),
    )
    expect(results.res[0]!.status).toBe("SUCCESS")
    expect(results.entities).toHaveLength(2)
  })
})
