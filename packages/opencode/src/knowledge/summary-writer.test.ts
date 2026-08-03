import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SummaryWriter, sanitizeDocumentId } from "./summary-writer"

const run = <A>(effect: Effect.Effect<A, Error, SummaryWriter>, dir: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(SummaryWriter.test(dir))))

describe("sanitizeDocumentId", () => {
  it("keeps safe chars and strips path separators", () => {
    expect(sanitizeDocumentId("10001")).toBe("10001")
    expect(sanitizeDocumentId("../../etc/passwd")).toBe("_".repeat(6) + "etc_passwd")
  })
})

describe("SummaryWriter", () => {
  it("writes source page and minimal schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-writer-"))
    try {
      await run(
        Effect.gen(function* () {
          const writer = yield* SummaryWriter
          yield* writer.write({
            workspaceLlmPath: dir,
            documentId: "10001",
            title: "考勤制度",
            markdown: "# 考勤制度\n\n## 核心观点\n\n- 要点一",
          })
        }),
        dir,
      )
      const page = await readFile(join(dir, "wiki", "sources", "10001.md"), "utf-8")
      expect(page).toContain("title: 考勤制度")
      expect(page).toContain("type: summary")
      expect(page).toContain("# 考勤制度")
      const schema = await readFile(join(dir, ".wiki-schema.md"), "utf-8")
      expect(schema).toContain("语言：中文")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("bumps updated date on overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-writer-"))
    try {
      await run(
        Effect.gen(function* () {
          const writer = yield* SummaryWriter
          yield* writer.write({ workspaceLlmPath: dir, documentId: "1", title: "t", markdown: "# 旧" })
          yield* writer.write({ workspaceLlmPath: dir, documentId: "1", title: "t", markdown: "# 新" })
        }),
        dir,
      )
      const page = await readFile(join(dir, "wiki", "sources", "1.md"), "utf-8")
      expect(page).toContain("# 新")
      expect(page).toMatch(/updated: \d{4}-\d{2}-\d{2}/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("deletes source page and ignores missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-writer-"))
    try {
      await run(
        Effect.gen(function* () {
          const writer = yield* SummaryWriter
          yield* writer.write({ workspaceLlmPath: dir, documentId: "1", title: "t", markdown: "# x" })
          yield* writer.delete({ workspaceLlmPath: dir, documentId: "1" })
          yield* writer.delete({ workspaceLlmPath: dir, documentId: "2" })
        }),
        dir,
      )
      const exists = await access(join(dir, "wiki", "sources", "1.md")).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects path traversal in documentId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kg-writer-"))
    try {
      await run(
        Effect.gen(function* () {
          const writer = yield* SummaryWriter
          yield* writer.write({ workspaceLlmPath: dir, documentId: "../evil", title: "t", markdown: "# x" })
        }),
        dir,
      )
      const escaped = await access(join(dir, "evil.md")).then(() => true).catch(() => false)
      expect(escaped).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
