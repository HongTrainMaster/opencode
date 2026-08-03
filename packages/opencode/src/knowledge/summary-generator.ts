import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"

export interface SummarizeArgs {
  title: string
  text: string
}

export type SummarizeResult =
  | { kind: "success"; markdown: string }
  | { kind: "skipped" }

export interface SummaryGeneratorShape {
  readonly summarize: (args: SummarizeArgs) => Effect.Effect<SummarizeResult>
}

export class SummaryGenerator extends Context.Service<
  SummaryGenerator,
  SummaryGeneratorShape
>()("@opencode/knowledge/SummaryGenerator") {
  static layer = Layer.effect(
    SummaryGenerator,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const baseUrl = yield* EffectConfig.string("KNOWLEDGE_LLM_BASE_URL").pipe(EffectConfig.withDefault(""))
      const apiKey = yield* EffectConfig.string("KNOWLEDGE_LLM_API_KEY").pipe(EffectConfig.withDefault(""))
      const model = yield* EffectConfig.string("KNOWLEDGE_LLM_MODEL").pipe(EffectConfig.withDefault("gpt-4o-mini"))
      return SummaryGenerator.of({
        summarize: (args) =>
          Effect.gen(function* () {
            if (!baseUrl) return { kind: "skipped" }
            const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`
            const response = yield* http
              .execute(
                HttpClientRequest.post(url).pipe(
                  HttpClientRequest.setHeader("Content-Type", "application/json"),
                  HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
                  HttpClientRequest.setBody(
                    HttpBody.jsonUnsafe({
                      model,
                      temperature: 0.3,
                      messages: [
                        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
                        { role: "user", content: `文档标题：${args.title}\n\n正文：\n${truncateText(args.text, 24_000)}` },
                      ],
                    }),
                  ),
                ),
              )
              .pipe(Effect.catch(() => Effect.succeed(null)))
            if (!response || response.status !== 200) return { kind: "skipped" }
            const body = (yield* Effect.catch(response.json, () => Effect.succeed(null))) as
              | { choices?: Array<{ message?: { content?: string } }> }
              | null
            const content = body?.choices?.[0]?.message?.content
            if (!content) return { kind: "skipped" }
            return { kind: "success", markdown: content }
          }),
      })
    }),
  )

  static test = (summarize: SummaryGeneratorShape["summarize"]) =>
    Layer.succeed(SummaryGenerator, SummaryGenerator.of({ summarize }))
}

const SUMMARY_SYSTEM_PROMPT = `你是一个企业文档摘要助手。请为给定的文档生成一份结构化的 markdown 摘要（llm-wiki source 页）。
只输出 markdown 正文，格式如下：
# <文档标题>

> <一句话核心观点>

## 核心观点

（3-5 个要点，每个 1-2 句话）

## 关键概念

（列出正文中的重要概念，每行一个 [[概念名]] 链接，至少 2 个）

## 原文精彩摘录

（2-3 段值得原样保留的原文，用引用块）

要求：
1. 使用中文。
2. [[wikilinks]] 用于关键概念，概念名使用原文表述。
3. 不输出 YAML frontmatter（由系统在写盘时补充）。`

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
