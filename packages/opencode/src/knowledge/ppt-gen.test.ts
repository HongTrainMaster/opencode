import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { PptGenService } from "./ppt-gen"

const skillDir = join(import.meta.dir, "ppt-skill")

/** 生成一个极简 .pptx 供 analyze/build 冒烟（不含真实内容，仅验证脚本可跑通） */
function makeMinimalPptx(dir: string): string {
  // 用 python-pptx 现场生成一个 1 页 pptx 作为测试样本；无 python 环境则跳过
  const sample = join(dir, "sample.pptx")
  const code = `
from pptx import Presentation
p = Presentation()
l = p.slide_layouts[5]
s = p.slides.add_slide(l)
s.shapes.title.text = "T"
p.save(${JSON.stringify(sample)})
`
  const r = spawnSync("python3", ["-c", code], { encoding: "utf-8" })
  if (r.status !== 0) return "" // python3 缺失 → 返回空，调用方跳过
  return sample
}

describe("ppt-gen skill scripts", () => {
  it("analyze.py outputs a valid layouts catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppt-test-"))
    const sample = makeMinimalPptx(dir)
    if (!sample) return // 环境无 python3 时跳过
    const r = spawnSync("python3", [join(skillDir, "scripts", "analyze.py"), sample], { encoding: "utf-8" })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(Array.isArray(out.layouts)).toBe(true)
  })

  it("build.py reuses a layout and writes an output file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppt-test-"))
    const sample = makeMinimalPptx(dir)
    if (!sample) return
    const deck = join(dir, "deck.json")
    writeFileSync(deck, JSON.stringify({ layouts: [{ layoutIndex: 0, placeholders: [] }] }))
    const out = join(dir, "out.pptx")
    const r = spawnSync("python3", [join(skillDir, "scripts", "build.py"), sample, deck, out], { encoding: "utf-8" })
    expect(r.status).toBe(0)
    expect(existsSync(out)).toBe(true)
  })
})

describe("PptGenService", () => {
  it("has a test layer that injects the gen function", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PptGenService
        return yield* svc.gen({
          taskId: "ppt_1",
          prompt: "x",
          styleFileName: "a.pptx",
          styleContentBase64: Buffer.from("stub").toString("base64"),
        })
      }).pipe(Effect.provide(PptGenService.test(() => Effect.succeed({ status: "SUCCESS" as const, outputPath: "/tmp/o.pptx" })))),
    )
    expect(result.status).toBe("SUCCESS")
    expect(result.outputPath).toBe("/tmp/o.pptx")
  })
})
