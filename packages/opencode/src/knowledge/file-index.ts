import { Context, Effect, Layer } from "effect"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 知识库内存文件索引（KnowledgeFileIndex）
 *
 * 解决 llm-wiki query 时 agent 在 aistore 等大型知识库目录里反复 glob/grep 扫盘导致查询慢的问题：
 * - 首次访问时把指定知识库根目录下的文件清单加载进内存（并缓存）
 * - `searchByName(query)` 先在内存里按"文件名(basename)/相对路径"匹配，命中即返回，不再扫盘
 *
 * 目录用环境变量 KNOWLEDGE_FILE_INDEX_ROOTS 配置（逗号分隔绝对路径）；未配置时仍可按需传入 root 调用。
 * 只做文件名级匹配（正是 llm-wiki 排序规则里最高优先级）；纯内存，不写盘，便于测试。
 */

/** 索引项：真实绝对路径 + 相对 root 的路径 + 文件名（basename） */
export interface IndexedFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly name: string
}

export interface KnowledgeFileIndexShape {
  /** 内存中按文件名搜索，返回相关性降序。root 首次访问时懒构建并缓存。 */
  readonly searchByName: (input: {
    root: string
    query: string
    limit?: number
  }) => Effect.Effect<readonly IndexedFile[]>
  /** 某 root 索引的文件总数（诊断用）。 */
  readonly size: (root: string) => Effect.Effect<number>
}

export class KnowledgeFileIndex extends Context.Service<KnowledgeFileIndex, KnowledgeFileIndexShape>()(
  "@opencode/knowledge/FileIndex",
) {}

/** 递归扫描目录收集文件（忽略隐藏项，保留 .wiki-schema.md）。同步实现，简单可靠。 */
export function scanFiles(dir: string, prefix = ""): IndexedFile[] {
  const result: IndexedFile[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return result
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".wiki-schema.md") continue
    const absolutePath = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(absolutePath).isDirectory()
    } catch {
      continue
    }
    const rel = prefix ? `${prefix}/${name}` : name
    if (isDir) result.push(...scanFiles(absolutePath, rel))
    else result.push({ absolutePath, relativePath: rel, name })
  }
  return result
}

function defaultRoots(): string[] {
  const env = process.env.KNOWLEDGE_FILE_INDEX_ROOTS
  return env ? env.split(",").map((s) => s.trim()).filter(Boolean) : []
}

/** 与 llm-wiki 排序一致：basename 精确=100 > basename 前缀=80 > basename 子串=60 > 相对路径子串=40。 */
export function score(item: IndexedFile, query: string): number {
  const q = query.toLowerCase()
  const name = item.name.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  if (item.relativePath.toLowerCase().includes(q)) return 40
  return 0
}

/**
 * 生产层：懒构建 + 按环境变量 KNOWLEDGE_FILE_INDEX_ROOTS 预热。
 * 预热在 layer 构建时同步执行（service 在 server 启动时构建一次，随后 constant 常驻内存）。
 */
export const layer = Layer.effect(
  KnowledgeFileIndex,
  Effect.gen(function* () {
    const cache = new Map<string, IndexedFile[]>()
    const ensureBuilt = (root: string): IndexedFile[] => {
      const existing = cache.get(root)
      if (existing) return existing
      const files = scanFiles(root)
      cache.set(root, files)
      return files
    }
    // 预热：构建时把配置 roots 指纹预加载（同步，确保 searchByName 秒回）
    for (const root of defaultRoots()) ensureBuilt(root)

    return KnowledgeFileIndex.of({
      searchByName: ({ root, query, limit }) =>
        Effect.sync(() => {
          const files = ensureBuilt(root)
          return files
            .map((f) => ({ f, s: score(f, query) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.f.relativePath.length - b.f.relativePath.length)
            .slice(0, limit ?? 50)
            .map((x) => x.f)
        }),
      size: (root) => Effect.sync(() => ensureBuilt(root).length),
    })
  }),
)

/** 测试层：直接用传入的 roots 扫描，不经环境变量。 */
export const test = (roots: string[]) =>
  Layer.succeed(
    KnowledgeFileIndex,
    KnowledgeFileIndex.of({
      searchByName: ({ root, query, limit }) =>
        Effect.sync(() => {
          const files = scanFiles(root)
          return files
            .map((f) => ({ f, s: score(f, query) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.f.relativePath.length - b.f.relativePath.length)
            .slice(0, limit ?? 50)
            .map((x) => x.f)
        }),
      size: (root) => Effect.sync(() => scanFiles(root).length),
    }),
  )
