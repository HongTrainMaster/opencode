import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { SummaryWriter, sanitizeDocumentId } from "@/knowledge/summary-writer"
import { KnowledgeApi } from "../groups/knowledge"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCES_DIR = "wiki/sources"

export const KnowledgeSummaryHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.summary",
  (handlers) =>
    Effect.gen(function* () {
      const writer = yield* SummaryWriter
      return handlers
        .handle(
          "list",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const { llmPath, documentId } = ctx.query as { llmPath: string; documentId: string }
            const safeId = sanitizeDocumentId(documentId)
            const target = join(llmPath, SOURCES_DIR, `${safeId}.md`)
            try {
              if (!existsSync(target)) {
                return { exists: false, content: null }
              }
              const content = readFileSync(target, "utf-8")
              return { exists: true, content }
            } catch {
              return { exists: false, content: null }
            }
          }),
        )
        .handle(
          "write",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const { llmPath, documentId, title, markdown } = ctx.payload as {
              llmPath: string
              documentId: string
              title: string
              markdown: string
            }
            const ok = yield* writer
              .write({ workspaceLlmPath: llmPath, documentId, title, markdown })
              .pipe(
                Effect.match({
                  onFailure: () => false,
                  onSuccess: () => true,
                }),
              )
            if (!ok) {
              // 写失败：返回 HTTP 500（SummaryWriteResponse.status 为 Literal("SUCCESS")，
              // 失败经非 200 暴露；ruoyi 侧以 resp.isOk() 判定失败，不更新 summary）
              return HttpServerResponse.empty({ status: 500 })
            }
            return { documentId, status: "SUCCESS" }
          }),
        )
    }),
)
