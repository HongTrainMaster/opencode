import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IngestJobService } from "./ingest-job"
import { KnowledgeGraphStore } from "./store"

// 重启兜底测试用文件 db（跨两次 layer 构造共享）；其余用例用 :memory:
let sharedDbPath = join(tmpdir(), "kg-ingest-job-test")

const storeLayer = KnowledgeGraphStore.test(":memory:")
const fileStoreLayer = () => KnowledgeGraphStore.test(sharedDbPath)

const runWithLayer = <A>(
  effect: Effect.Effect<A, unknown, IngestJobService>,
  layer: Layer.Layer<IngestJobService, never, KnowledgeGraphStore> = IngestJobService.layer,
  store: Layer.Layer<KnowledgeGraphStore> = storeLayer,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.provide(store),
    ),
  )

describe("IngestJobService", () => {
  it("start returns a jobId and the job reaches SUCCESS with counts", async () => {
    const { jobId, job } = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const jobId = yield* svc.start({
          documentId: "10001",
          workspaceId: "kb_1",
          operation: "CREATE",
          run: Effect.succeed({ entities: 3, relations: 2, summary: "SUCCESS" }),
        })
        // 轮询直到终态
        for (let i = 0; i < 50; i++) {
          const j = yield* svc.get(jobId)
          if (j && j.status !== "RUNNING") return { jobId, job: j }
          yield* Effect.sleep("10 millis")
        }
        throw new Error("timed out")
      }),
    )
    expect(jobId).toBeTruthy()
    expect(job.status).toBe("SUCCESS")
    expect(job.entities).toBe(3)
    expect(job.relations).toBe(2)
    expect(job.summary).toBe("SUCCESS")
    expect(job.documentId).toBe("10001")
    expect(job.operation).toBe("CREATE")
  })

  it("marks job FAILED with error when run fails", async () => {
    const job = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const jobId = yield* svc.start({
          documentId: "10001",
          workspaceId: "kb_1",
          operation: "CREATE",
          run: Effect.fail(new Error("boom")),
        })
        for (let i = 0; i < 50; i++) {
          const j = yield* svc.get(jobId)
          if (j && j.status !== "RUNNING") return j
          yield* Effect.sleep("10 millis")
        }
        throw new Error("timed out")
      }),
    )
    expect(job.status).toBe("FAILED")
    expect(job.error).toContain("boom")
  })

  it("list returns jobs in input order", async () => {
    const { ids, jobs } = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        const id1 = yield* svc.start({
          documentId: "1",
          workspaceId: "kb_1",
          operation: "CREATE",
          run: Effect.succeed({ entities: 1, relations: 0, summary: null }),
        })
        const id2 = yield* svc.start({
          documentId: "2",
          workspaceId: "kb_1",
          operation: "DELETE",
          run: Effect.succeed({ entities: 0, relations: 0, summary: null }),
        })
        for (let i = 0; i < 50; i++) {
          const j1 = yield* svc.get(id1)
          const j2 = yield* svc.get(id2)
          if (j1?.status !== "RUNNING" && j2?.status !== "RUNNING") break
          yield* Effect.sleep("10 millis")
        }
        const jobs = yield* svc.list([id1, id2])
        return { ids: [id1, id2], jobs }
      }),
    )
    expect(jobs).toHaveLength(2)
    expect(jobs[0]!.id).toBe(ids[0])
    expect(jobs[1]!.id).toBe(ids[1])
  })

  it("marks leftover RUNNING rows INTERRUPTED on layer construction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-ingest-job-"))
    sharedDbPath = join(dir, "shared.db")
    // 第一次：只用 store（不构造 IngestJobService.layer，避免提前执行重启兜底），插一行 RUNNING 模拟崩溃残留
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* KnowledgeGraphStore
        yield* store.insertIngestJob({
          id: "job_stale",
          documentId: "10001",
          workspaceId: "kb_1",
          operation: "CREATE",
          status: "RUNNING",
        })
      }).pipe(Effect.provide(fileStoreLayer())),
    )
    // 第二次：真实 IngestJobService.layer（同一文件 db），构造时执行重启兜底 → INTERRUPTED
    const job = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* IngestJobService
        return yield* svc.get("job_stale")
      }),
      IngestJobService.layer,
      fileStoreLayer(),
    )
    expect(job?.status).toBe("INTERRUPTED")
    // SQLite 文件句柄在 layer 生命周期内不释放，删除会 EBUSY；交由 OS 临时目录清理，此处显式尝试删除并忽略失败
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})
