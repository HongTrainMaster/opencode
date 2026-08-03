import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EntityExtractor, heuristicExtract } from "./entity-extractor"

const runWith =
  (extract: (args: { title: string; text: string }) => Effect.Effect<never, never, never>) =>
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
