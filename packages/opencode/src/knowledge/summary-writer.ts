import { Context, Effect, Layer } from "effect"
import { access, mkdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface SummaryWriterShape {
  readonly write: (args: {
    workspaceLlmPath: string
    documentId: string
    title: string
    markdown: string
  }) => Effect.Effect<void>
  readonly delete: (args: { workspaceLlmPath: string; documentId: string }) => Effect.Effect<void>
}

export class SummaryWriter extends Context.Service<SummaryWriter, SummaryWriterShape>()(
  "@opencode/knowledge/SummaryWriter",
) {
  static layer = Layer.succeed(SummaryWriter, SummaryWriter.of(makeWriter(null)))

  static test = (dir: string) => Layer.succeed(SummaryWriter, SummaryWriter.of(makeWriter(dir)))
}

// --- helpers ---

export function sanitizeDocumentId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_")
}

const MINIMAL_SCHEMA = `# Wiki Schema

## 语言
语言：中文

## 别名词表
（可选：格式 \`术语A = 术语B\`，每行一组）

## 关系类型词汇表
（可选：实现 / 依赖 / 对比 / 矛盾 / 衍生）
`

function frontmatter(title: string, created: string, updated: string): string {
  return `---
title: ${title}
created: ${created}
updated: ${updated}
type: summary
tags: []
sources: []
---
`
}

function makeWriter(rootOverride: string | null): SummaryWriterShape {
  const today = () => new Date().toISOString().slice(0, 10)

  const ensureSchema = (workspaceLlmPath: string): Effect.Effect<void> =>
    Effect.tryPromise({
      try: async () => {
        const schemaPath = join(workspaceLlmPath, ".wiki-schema.md")
        const exists = await access(schemaPath).then(() => true).catch(() => false)
        if (!exists) {
          await mkdir(workspaceLlmPath, { recursive: true })
          await writeFile(schemaPath, MINIMAL_SCHEMA, "utf-8")
        }
      },
      catch: (error) => {
        throw new Error(`failed to ensure wiki schema: ${String(error)}`)
      },
    })

  return {
    write: ({ workspaceLlmPath, documentId, title, markdown }) =>
      Effect.gen(function* () {
        const safeId = sanitizeDocumentId(documentId)
        const sourcesDir = join(workspaceLlmPath, "wiki", "sources")
        yield* ensureSchema(workspaceLlmPath)
        const created = today()
        const content = frontmatter(title, created, created) + "\n" + markdown.trim() + "\n"
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(sourcesDir, { recursive: true })
            await writeFile(join(sourcesDir, `${safeId}.md`), content, "utf-8")
          },
          catch: (error) => {
            throw new Error(`failed to write summary: ${String(error)}`)
          },
        })
      }),

    delete: ({ workspaceLlmPath, documentId }) =>
      Effect.gen(function* () {
        const safeId = sanitizeDocumentId(documentId)
        const filePath = join(workspaceLlmPath, "wiki", "sources", `${safeId}.md`)
        yield* Effect.tryPromise({
          try: async () => {
            try {
              await unlink(filePath)
            } catch (error: unknown) {
              if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
              throw error
            }
          },
          catch: (error) => {
            throw new Error(`failed to delete summary: ${String(error)}`)
          },
        })
      }),
  }
}
