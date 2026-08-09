import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildWikiPrompt, findNewSourcePages, injectDocumentId } from "./wiki-session"

describe("buildWikiPrompt", () => {
  it("includes the init workflow step when the knowledge base is not initialized", () => {
    const prompt = buildWikiPrompt("考勤制度", "正文内容", "2086303206978322433", false)
    expect(prompt).toContain("init-wiki.sh")
    expect(prompt).toContain("没有 .wiki-schema.md")
    expect(prompt).toContain("考勤制度")
    expect(prompt).toContain("正文内容")
    expect(prompt).toContain("documentId: 2086303206978322433")
  })

  it("skips the init workflow step when the knowledge base is already initialized", () => {
    const prompt = buildWikiPrompt("考勤制度", "正文内容", "2086303206978322433", true)
    expect(prompt).not.toContain("init-wiki.sh")
    expect(prompt).not.toContain("没有 .wiki-schema.md")
    expect(prompt).toContain("ingest 工作流")
  })
})

describe("findNewSourcePages", () => {
  it("returns only the .md files newly added after the session started", () => {
    const before = new Set(["2026-01-01-旧文档.md"])
    expect(findNewSourcePages(before, ["2026-01-01-旧文档.md", "2026-08-05-新文档.md"])).toEqual([
      "2026-08-05-新文档.md",
    ])
    // 忽略非 .md 与既有文件
    expect(findNewSourcePages(before, ["2026-01-01-旧文档.md", "index.md.tmp", "notes.txt"])).toEqual([])
  })
})

describe("wiki initialization detection", () => {
  it("detects an initialized knowledge base by the presence of .wiki-schema.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-init-"))
    try {
      expect(existsSync(join(dir, ".wiki-schema.md"))).toBe(false)
      mkdirSync(join(dir, "wiki"), { recursive: true })
      // Simulate llm-wiki init producing the schema file
      writeFileSync(join(dir, ".wiki-schema.md"), "# Wiki Schema\n语言：中文\n")
      expect(existsSync(join(dir, ".wiki-schema.md"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("injectDocumentId", () => {
  const documentId = "2086303206978322433"

  it("adds a frontmatter when the source page has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-inject-"))
    const file = join(dir, "2026-08-09-测试页.md")
    try {
      writeFileSync(file, "# 测试页\n\n正文内容\n")
      injectDocumentId(file, documentId)
      expect(readFileSync(file, "utf8")).toBe(
        `---\ndocumentId: ${documentId}\n---\n\n# 测试页\n\n正文内容\n`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends documentId into an existing frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-inject-"))
    const file = join(dir, "2026-08-09-测试页.md")
    try {
      writeFileSync(file, "---\ntitle: 测试页\nlanguage: 中文\n---\n\n# 测试页\n")
      injectDocumentId(file, documentId)
      expect(readFileSync(file, "utf8")).toContain("documentId: 2086303206978322433")
      // 原有字段保留
      expect(readFileSync(file, "utf8")).toContain("title: 测试页")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is idempotent when documentId already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-inject-"))
    const file = join(dir, "2026-08-09-测试页.md")
    try {
      writeFileSync(file, `---\ndocumentId: ${documentId}\n---\n\n# 测试页\n`)
      injectDocumentId(file, documentId)
      const after = readFileSync(file, "utf8")
      expect(after).toBe(`---\ndocumentId: ${documentId}\n---\n\n# 测试页\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
