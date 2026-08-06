import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { PptJobService } from "./ppt-job"
import { KnowledgeGraphStore } from "./store"

const storeLayer = KnowledgeGraphStore.test(":memory:")

const runWithLayer = <A>(
  effect: Effect.Effect<A, unknown, PptJobService>,
  store: Layer.Layer<KnowledgeGraphStore> = storeLayer,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PptJobService.layer),
      Effect.provide(store),
    ),
  )

describe("PptJobService", () => {
  it("start returns a jobId and the job reaches SUCCESS with outputPath", async () => {
    const { jobId, job } = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* PptJobService
        const jobId = yield* svc.start({
          taskId: "ppt_1",
          prompt: "做公司介绍",
          run: Effect.succeed({ outputPath: "/tmp/result.pptx" }),
        })
        for (let i = 0; i < 100; i++) {
          const j = yield* svc.get(jobId)
          if (j && j.status !== "RUNNING") return { jobId, job: j }
          yield* Effect.sleep("10 millis")
        }
        throw new Error("timed out")
      }),
    )
    expect(jobId).toBeTruthy()
    expect(job.status).toBe("SUCCESS")
    expect(job.outputPath).toBe("/tmp/result.pptx")
    expect(job.taskId).toBe("ppt_1")
  })

  it("marks job FAILED with error when run fails", async () => {
    const job = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* PptJobService
        const jobId = yield* svc.start({
          taskId: "ppt_2",
          prompt: "x",
          run: Effect.fail(new Error("build failed")),
        })
        for (let i = 0; i < 100; i++) {
          const j = yield* svc.get(jobId)
          if (j && j.status !== "RUNNING") return j
          yield* Effect.sleep("10 millis")
        }
        throw new Error("timed out")
      }),
    )
    expect(job.status).toBe("FAILED")
    expect(job.error).toBe("build failed")
  })

  it("list returns jobs in input order", async () => {
    const { ids, jobs } = await runWithLayer(
      Effect.gen(function* () {
        const svc = yield* PptJobService
        const id1 = yield* svc.start({ taskId: "a", prompt: "x", run: Effect.succeed({ outputPath: "/tmp/1.pptx" }) })
        const id2 = yield* svc.start({ taskId: "b", prompt: "y", run: Effect.succeed({ outputPath: "/tmp/2.pptx" }) })
        for (let i = 0; i < 100; i++) {
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
})
