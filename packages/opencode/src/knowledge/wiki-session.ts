import { Context, Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface WikiSessionBuildResult {
  status: "SUCCESS" | "SKIPPED"
  /** wiki 会话实际写入的 source 页绝对路径（status 为 SUCCESS 时必有） */
  sourcePath?: string
  error?: string
}

export interface WikiSessionServiceShape {
  readonly build: (args: {
    workspaceLlmPath: string
    documentId: string
    title: string
    text: string
  }) => Effect.Effect<WikiSessionBuildResult>
}

export class WikiSessionService extends Context.Service<WikiSessionService, WikiSessionServiceShape>()(
  "@opencode/knowledge/WikiSession",
) {
  static layer = Layer.effect(
    WikiSessionService,
    Effect.gen(function* () {
      const store: InstanceStore.Interface = yield* InstanceStore.Service
      const session: Session.Interface = yield* Session.Service
      const promptSvc: SessionPrompt.Interface = yield* SessionPrompt.Service
      return WikiSessionService.of({
        build: (args) => runWikiSession(store, session, promptSvc, args),
      })
    }),
  )

  static test = (build: WikiSessionServiceShape["build"]) =>
    Layer.succeed(WikiSessionService, WikiSessionService.of({ build }))
}

const WIKI_MODEL = {
  providerID: ProviderV2.ID.make("hsl"),
  modelID: ModelV2.ID.make("nvidia/Qwen3.6-35B-A3B-NVFP4"),
} as const

// Mirror the CLI's non-interactive ruleset: deny question/plan so the headless
// session never blocks on a user prompt while running the wiki skill.
const HEADLESS_RULESET: PermissionV1.Ruleset = [
  { permission: "question", action: "deny", pattern: "*" },
  { permission: "plan_enter", action: "deny", pattern: "*" },
  { permission: "plan_exit", action: "deny", pattern: "*" },
]

function runWikiSession(
  store: InstanceStore.Interface,
  session: Session.Interface,
  promptSvc: SessionPrompt.Interface,
  args: { workspaceLlmPath: string; documentId: string; title: string; text: string },
): Effect.Effect<WikiSessionBuildResult> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("wiki session start", {
      workspaceLlmPath: args.workspaceLlmPath,
      documentId: args.documentId,
      model: WIKI_MODEL,
    })

    // Ensure the target directory exists before opening a session against it, so
    // InstanceStore / llm-wiki can write into it. If it is not yet initialized
    // as an llm-wiki knowledge base (no .wiki-schema.md), tell the agent to run
    // the init workflow first, then ingest.
    yield* Effect.sync(() => mkdirSync(args.workspaceLlmPath, { recursive: true }))
    const initialized = existsSync(join(args.workspaceLlmPath, ".wiki-schema.md"))
    if (!initialized) {
      yield* Effect.logInfo("wiki session: knowledge base not initialized, will init first", {
        workspaceLlmPath: args.workspaceLlmPath,
      })
    }

    // 会话开始前快照 wiki/sources/，结束后校验是否有新 source 页写入。
    // 避免"LLM 调用成功但实际没写文件"被误判为成功（根因2）。
    const sourcesDir = join(args.workspaceLlmPath, "wiki", "sources")
    const readSources = (): string[] => {
      try {
        return readdirSync(sourcesDir)
      } catch {
        return []
      }
    }
    const beforeSources = new Set(readSources())

    const prompt = buildWikiPrompt(args.title, args.text, initialized)

    const result = yield* store.provide(
      { directory: args.workspaceLlmPath },
      Effect.gen(function* () {
        const created = yield* session.create({
          title: `ingest: ${args.title}`,
          model: { id: WIKI_MODEL.modelID, providerID: WIKI_MODEL.providerID },
          permission: HEADLESS_RULESET,
        })

        yield* Effect.logInfo("wiki session created", { sessionID: created.id, documentId: args.documentId })

        return yield* promptSvc.prompt({
          sessionID: created.id,
          model: WIKI_MODEL,
          parts: [{ type: "text", text: prompt }],
        })
      }),
    )

    const lastText = result.parts.findLast((part) => part.type === "text")?.text
    yield* Effect.logInfo("wiki session done", {
      documentId: args.documentId,
      status: "SUCCESS",
      textLength: lastText?.length ?? 0,
    })

    // 校验产物：会话期间 wiki/sources/ 必须有新 source 页，否则视为 SKIPPED
    const newPages = findNewSourcePages(beforeSources, readSources())
    if (newPages.length === 0) {
      yield* Effect.logWarning("wiki session finished but no source page written", {
        documentId: args.documentId,
        workspaceLlmPath: args.workspaceLlmPath,
        beforeCount: beforeSources.size,
        afterCount: readSources().length,
      })
      return {
        status: "SKIPPED" as const,
        error: "wiki session finished but no source page written under wiki/sources",
      }
    }
    const sourcePath = join(sourcesDir, newPages[0]!)
    yield* Effect.logInfo("wiki session wrote source page", {
      documentId: args.documentId,
      workspaceLlmPath: args.workspaceLlmPath,
      sourcePath,
      newPageCount: newPages.length,
    })
    return { status: "SUCCESS" as const, sourcePath }
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("wiki session failed", {
        workspaceLlmPath: args.workspaceLlmPath,
        documentId: args.documentId,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as({ status: "SKIPPED" as const, error: error instanceof Error ? error.message : String(error) })),
    ),
  )
}

/** 会话期间 wiki/sources/ 下新增的 .md 页（用于校验 wiki 会话是否真的写了产物） */
export function findNewSourcePages(before: Set<string>, after: string[]): string[] {
  return after.filter((f) => f.endsWith(".md") && !before.has(f))
}

export function buildWikiPrompt(title: string, text: string, initialized: boolean): string {
  const steps: string[] = []
  if (!initialized) {
    steps.push(
      `1. 当前目录还不是一个 llm-wiki 知识库（没有 .wiki-schema.md）。先执行 llm-wiki 的 init 工作流：`,
      `   - 用当前工作目录作为知识库路径（不要向用户提问路径，也不要读 ~/.llm-wiki-path）。`,
      `   - 运行 bash \${SKILL_DIR}/scripts/init-wiki.sh "<当前工作目录>" "${title}"，跳过主题/语言/位置提问，默认中文。`,
      `   - 初始化完成后，再继续下面的 ingest 工作流。`,
    )
  }
  steps.push(
    `${steps.length + 1}. 加载 llm-wiki 技能（skill: llm-wiki），按其 SKILL.md 的 ingest 工作流执行。`,
    `${steps.length + 2}. 这是无头自动化入库，跳过隐私自检，不要向用户提问。`,
    `${steps.length + 3}. 将文档正文作为素材，先写入 raw 目录，再生成 source 页（wiki/sources/）和 entity 页（wiki/entities/），并更新 index.md、log.md。`,
    `${steps.length + 4}. 实体页用中文命名，符合知识库 schema。`,
  )
  return [
    `请对以下文档执行 llm-wiki 的 ingest 工作流，将其加入当前知识库。`,
    ``,
    `要求：`,
    ...steps,
    ``,
    `文档标题：${title}`,
    ``,
    `文档正文：`,
    ``,
    text,
  ].join("\n")
}
