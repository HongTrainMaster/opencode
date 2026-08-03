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

  // A test layer overrides the destination root; the production layer (null) writes to
  // whatever workspaceLlmPath the caller supplies.
  const resolveRoot = (workspaceLlmPath: string): string => rootOverride ?? workspaceLlmPath

  const ensureSchema = (workspaceLlmPath: string): Effect.Effect<void> => {
    const root = resolveRoot(workspaceLlmPath)
    return Effect.tryPromise({
      try: async () => {
        const schemaPath = join(root, ".wiki-schema.md")
        const exists = await access(schemaPath).then(() => true).catch(() => false)
        if (!exists) {
          await mkdir(root, { recursive: true })
          await writeFile(schemaPath, MINIMAL_SCHEMA, "utf-8")
        }
      },
      catch: (error) => {
        throw new Error(`failed to ensure wiki schema: ${String(error)}`)
      },
    })
  }

  return {
    write: ({ workspaceLlmPath, documentId, title, markdown }) =>
      Effect.gen(function* () {
        const safeId = sanitizeDocumentId(documentId)
        const root = resolveRoot(workspaceLlmPath)
        const sourcesDir = join(root, "wiki", "sources")
        yield* ensureSchema(root)
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
        const root = resolveRoot(workspaceLlmPath)
        const filePath = join(root, "wiki", "sources", `${safeId}.md`)
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
