import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { PptCoverService } from "./ppt-cover"

describe("PptCoverService", () => {
  it("test layer 注入 render 函数可拦截", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PptCoverService
        return yield* svc.render({
          taskId: "cover_1",
          styleFileName: "a.pptx",
          styleContentBase64: Buffer.from("stub").toString("base64"),
        })
      }).pipe(Effect.provide(PptCoverService.test(() =>
        Effect.succeed({ status: "SUCCESS" as const, outputPath: "/tmp/cover.png" })))),
    )
    expect(result.status).toBe("SUCCESS")
    expect(result.outputPath).toBe("/tmp/cover.png")
  })
})
