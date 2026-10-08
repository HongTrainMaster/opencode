import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { EntityExtractor, heuristicExtract } from "./entity-extractor"

const runWith =
  (extract: (args: { title: string; text: string }) => Effect.Effect<any, never, never>) =>
  (effect: Effect.Effect<any, never, EntityExtractor>) =>
    Effect.runPromise(effect.pipe(Effect.provide(EntityExtractor.test(extract))))

describe("EntityExtractor (injected)", () => {
  it("returns the injected extraction", async () => {
    const result = await runWith(({ title }) =>
      Effect.succeed({
        entities: [{ name: title, type: "文档" }],
        relations: [],
      }),
    )(
      Effect.gen(function* () {
        const ex = yield* EntityExtractor
        return yield* ex.extract({ title: "考勤制度", text: "正文" })
      }),
    )
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]!.name).toBe("考勤制度")
  })
})

describe("heuristicExtract", () => {
  it("extracts frequent terms as entities", () => {
    const text = "考勤制度 规定 考勤制度 考勤 人力资源部 负责 考勤制度 管理 制度"
    const graph = heuristicExtract(text)
    expect(graph.entities.length).toBeGreaterThan(0)
    expect(graph.entities.map((e) => e.name)).toContain("考勤制度")
    expect(graph.relations).toEqual([])
  })
})

describe("EntityExtractor (real layer, timeout)", () => {
  it("falls back to heuristic when the llm call hangs past KNOWLEDGE_LLM_TIMEOUT_MS", async () => {
    // 挂起的 LLM 客户端：连接建立后永不返回（模拟产线上端点不响应）
    const hangingClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never),
    )
    process.env.KNOWLEDGE_LLM_BASE_URL = "http://llm.test/v1"
    process.env.KNOWLEDGE_LLM_TIMEOUT_MS = "100"
    try {
      const startedAt = Date.now()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const ex = yield* EntityExtractor
          return yield* ex.extract({ title: "考勤制度", text: "考勤制度 考勤管理 人力资源部 考勤制度" })
        }).pipe(
          Effect.provide(Layer.provide(EntityExtractor.layer, hangingClient)),
        ),
      )
      // 超时降级到词频兜底：有实体、无关系，且没有被挂死
      expect(result.relations).toEqual([])
      expect(result.entities.length).toBeGreaterThan(0)
      expect(Date.now() - startedAt).toBeLessThan(5000)
    } finally {
      delete process.env.KNOWLEDGE_LLM_BASE_URL
      delete process.env.KNOWLEDGE_LLM_TIMEOUT_MS
    }
  })
})
