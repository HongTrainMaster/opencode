import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { SummaryGenerator } from "./summary-generator"

const runWith = (fn: SummaryGenerator["Service"]["summarize"]) =>
  (effect: Effect.Effect<any, never, SummaryGenerator>) =>
    Effect.runPromise(effect.pipe(Effect.provide(SummaryGenerator.test(fn))))

describe("SummaryGenerator (injected)", () => {
  it("returns the injected markdown", async () => {
    const result = await runWith(({ title }) =>
      Effect.succeed({ kind: "success", markdown: `# ${title}\n\n摘要内容` }),
    )(
      Effect.gen(function* () {
        const gen = yield* SummaryGenerator
        return yield* gen.summarize({ title: "考勤制度", text: "正文" })
      }),
    )
    expect(result.kind).toBe("success")
    if (result.kind === "success") expect(result.markdown).toContain("考勤制度")
  })

  it("can return skipped when LLM unavailable", async () => {
    const result = await runWith(() => Effect.succeed({ kind: "skipped" }))(
      Effect.gen(function* () {
        const gen = yield* SummaryGenerator
        return yield* gen.summarize({ title: "x", text: "y" })
      }),
    )
    expect(result.kind).toBe("skipped")
  })
})
