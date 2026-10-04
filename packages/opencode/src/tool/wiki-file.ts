import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { scanFiles, score, type IndexedFile } from "../knowledge/file-index"
import * as Tool from "./tool"

/**
 * wiki-file —— 知识库文件名内存索引查询工具。
 *
 * 解决 llm-wiki query 时在 aistore 等大型知识库目录里反复扫盘找文件导致的查询慢：
 * - 进程内缓存：首次扫描某根目录后常驻内存，后续查询不再扫盘（秒回）
 * - 文件名优先：按 basename 精确 > 前缀 > 子串 > 相对路径子串排序（与 llm-wiki 排序一致）
 *
 * 用法（agent）：给定知识库根目录 + 关键词，返回匹配的 wiki/ 源页/实体页文件名路径。
 * 命中后再用 read 读取，避免全库 grep。未配置根目录时用当前工作目录。
 */

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "文件名关键词（支持子串，不区分大小写；可用空格分隔多个关键词）" }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "知识库根目录（mm-wiki 目录，含 wiki/ 子目录）。默认取实例工作目录；也受 KNOWLEDGE_FILE_INDEX_ROOTS 前几个匹配项影响。",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "最大返回条数，默认 30。" }),
})

/** 进程级索引缓存：root -> 已扫描的文件清单（避免工具每次调用重复扫盘） */
const indexCache = new Map<string, IndexedFile[]>()
function getIndex(root: string): IndexedFile[] {
  const cached = indexCache.get(root)
  if (cached) return cached
  const files = scanFiles(root)
  indexCache.set(root, files)
  return files
}

/**
 * 命令式：text 里是否包含所有关键词（都用 空格/下划线/破折号/斜杠 分词后任一命中即可）。
 * 简单实现：把 query 按空白拆成多个词，全部词都在 name 或相对路径中命中才匹配（AND）。
 */
function matchesAll(item: IndexedFile, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const terms = q.split(/\s+/).filter(Boolean)
  const name = item.name.toLowerCase()
  const rel = item.relativePath.toLowerCase()
  return terms.every((t) => name.includes(t) || rel.includes(t))
}

export const WikiFileTool = Tool.define(
  "wiki-file",
  Effect.gen(function* () {
    return {
      description:
        "在知识库目录中按文件名（内存索引）快速查找 wiki 页面。适合 llm-wiki query 时先按文件名定位再 read，避免全库 grep。返回匹配的绝对路径列表。",
      parameters: Parameters,
      execute: (params: { query: string; path?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.query.trim()) {
            return { title: "wiki-file", metadata: { count: 0, truncated: false }, output: "query is required" }
          }
          const ins = yield* InstanceState.context
          const root = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.resolve(ins.directory, params.path ?? ".")
          yield* assertExternalDirectoryEffect(ctx, root, { bypass: false, kind: "directory" })

          const files = getIndex(root)
          const matched = files
            .filter((f) => matchesAll(f, params.query))
            .map((f) => ({ f, s: score(f, params.query) }))
            .filter((x) => x.s > 0 || true) // matchesAll 已保证命中，score 用于排序
            .sort((a, b) => b.s - a.s || a.f.relativePath.length - b.f.relativePath.length)
            .slice(0, params.limit ?? 30)
            .map((x) => x.f)

          const limit = params.limit ?? 30
          const truncated = matched.length === limit
          const lines = matched.map((f) => path.resolve(root, f.relativePath))
          const output =
            matched.length === 0
              ? "No knowledge files matched by filename."
              : [
                  `Found ${matched.length} files by filename${truncated ? " (truncated)" : ""}:`,
                  ...lines,
                ].join("\n")

          return {
            title: `wiki-file: ${params.query}`,
            metadata: { count: matched.length, truncated },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
