import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KnowledgeFileIndex, test as testIndexLayer } from "./file-index"
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function makeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kfi-")))
  mkdirSync(join(dir, "wiki", "sources"), { recursive: true })
  mkdirSync(join(dir, "wiki", "entities"), { recursive: true })
  writeFileSync(join(dir, "wiki", "sources", "2026-07-21-shuili-beidou-doc.md"), "content", "utf-8")
  writeFileSync(join(dir, "wiki", "sources", "2084952200768016386.md"), "content", "utf-8")
  writeFileSync(join(dir, "wiki", "entities", "beidou.md"), "content", "utf-8")
  writeFileSync(join(dir, ".wiki-schema.md"), "schema", "utf-8")
  writeFileSync(join(dir, ".hidden.md"), "ignored", "utf-8")
  return dir
}

const run = <A>(fx: Effect.Effect<A, never, KnowledgeFileIndex>, root: string) =>
  Effect.runPromise(fx.pipe(Effect.provide(testIndexLayer([root]))))

describe("KnowledgeFileIndex", () => {
  test("indexes files by name with basename-prefix priority", async () => {
    const dir = makeRoot()
    const res = await run(
      Effect.gen(function* () {
        const idx = yield* KnowledgeFileIndex
        return yield* idx.searchByName({ root: dir, query: "beidou" })
      }),
      dir,
    )
    expect(res.length).toBeGreaterThanOrEqual(1)
    expect(res[0]!.name).toContain("beidou")
    expect(res[0]!.relativePath).toMatch(/^wiki\/(sources|entities)\//)
  })

  test("exact basename match ranks above substring matches", async () => {
    const dir = makeRoot()
    const res = await run(
      Effect.gen(function* () {
        const idx = yield* KnowledgeFileIndex
        return yield* idx.searchByName({ root: dir, query: "2084952200768016386.md" })
      }),
      dir,
    )
    expect(res.length).toBeGreaterThanOrEqual(1)
    expect(res[0]!.name).toBe("2084952200768016386.md")
  })

  test("ignores hidden files except .wiki-schema.md", async () => {
    const dir = makeRoot()
    const hidden = await run(
      Effect.gen(function* () {
        const idx = yield* KnowledgeFileIndex
        return yield* idx.searchByName({ root: dir, query: ".hidden" })
      }),
      dir,
    )
    expect(hidden).toHaveLength(0)
    const schema = await run(
      Effect.gen(function* () {
        const idx = yield* KnowledgeFileIndex
        return yield* idx.searchByName({ root: dir, query: ".wiki-schema" })
      }),
      dir,
    )
    expect(schema.some((f) => f.name === ".wiki-schema.md")).toBe(true)
  })

  test("size counts all indexed files", async () => {
    const dir = makeRoot()
    const n = await run(
      Effect.gen(function* () {
        const idx = yield* KnowledgeFileIndex
        return yield* idx.size(dir)
      }),
      dir,
    )
    expect(n).toBe(4)
  })
})
