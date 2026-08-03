import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"

export interface ExtractedGraph {
  entities: Array<{ name: string; type: string }>
  relations: Array<{ head: string; tail: string; relation: string }>
}

export interface EntityExtractorShape {
  readonly extract: (args: { title: string; text: string }) => Effect.Effect<ExtractedGraph>
}

export class EntityExtractor extends Context.Service<
  EntityExtractor,
  EntityExtractorShape
>()("@opencode/knowledge/EntityExtractor") {
  static layer = Layer.effect(
    EntityExtractor,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const baseUrl = yield* EffectConfig.string("KNOWLEDGE_LLM_BASE_URL").pipe(EffectConfig.withDefault(""))
      const apiKey = yield* EffectConfig.string("KNOWLEDGE_LLM_API_KEY").pipe(EffectConfig.withDefault(""))
      const model = yield* EffectConfig.string("KNOWLEDGE_LLM_MODEL").pipe(EffectConfig.withDefault("gpt-4o-mini"))
      return EntityExtractor.of({
        extract: (args) =>
          Effect.gen(function* () {
            if (!baseUrl) return heuristicExtract(args.text)
            const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`
            const response = yield* http
              .execute(
                HttpClientRequest.post(url).pipe(
                  HttpClientRequest.setHeader("Content-Type", "application/json"),
                  HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
                  HttpClientRequest.setBody(
                    HttpBody.jsonUnsafe({
                      model,
                      temperature: 0,
                      response_format: { type: "json_object" },
                      messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: `文档标题：${args.title}\n\n正文：\n${truncateText(args.text, 24_000)}` },
                      ],
                    }),
                  ),
                ),
              )
              .pipe(Effect.catch(() => Effect.succeed(null)))
            if (!response || response.status !== 200) return heuristicExtract(args.text)
            const body = (yield* Effect.catch(response.json, () => Effect.succeed(null))) as
              | { choices?: Array<{ message?: { content?: string } }> }
              | null
            const content = body?.choices?.[0]?.message?.content
            if (!content) return heuristicExtract(args.text)
            return yield* parseLlmOutput(content).pipe(Effect.catch(() => Effect.succeed(heuristicExtract(args.text))))
          }),
      })
    }),
  )

  static test = (extract: EntityExtractorShape["extract"]) =>
    Layer.succeed(EntityExtractor, EntityExtractor.of({ extract }))
}

const SYSTEM_PROMPT = `你是一个知识图谱实体抽取助手。请从给定的文档正文中抽取核心实体及其关系。
只输出 JSON，格式如下：
{"entities":[{"name":"实体名","type":"制度|流程|角色|项目|概念|文档|产品"}],"relations":[{"head":"实体名","tail":"实体名","relation":"关系类型"}]}
要求：
1. 实体名使用原文表述，不要改写、不要翻译。
2. type 只能从列表中选取：制度,流程,角色,项目,概念,文档,产品。
3. relation 使用简短动词或名词，例如：包含,负责,定义,引用,隶属于,编写。
4. 抽取的实体应尽量完整，但不要超过 50 个。
5. 只输出 JSON，不要输出任何其他文字或注释。`

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function parseLlmOutput(content: string): Effect.Effect<ExtractedGraph> {
  return Effect.try(() => {
    const data = JSON.parse(content) as {
      entities?: Array<{ name?: unknown; type?: unknown }>
      relations?: Array<{ head?: unknown; tail?: unknown; relation?: unknown }>
    }
    const entities = (data.entities ?? [])
      .map((e) => ({
        name: typeof e.name === "string" ? e.name.trim() : "",
        type: typeof e.type === "string" ? e.type.trim() : "概念",
      }))
      .filter((e) => e.name.length > 0)
      .slice(0, 50)
    const nameSet = new Set(entities.map((e) => e.name))
    const relations = (data.relations ?? [])
      .map((r) => ({
        head: typeof r.head === "string" ? r.head.trim() : "",
        tail: typeof r.tail === "string" ? r.tail.trim() : "",
        relation: typeof r.relation === "string" ? r.relation.trim() : "",
      }))
      .filter((r) => r.head && r.tail && r.relation && nameSet.has(r.head) && nameSet.has(r.tail))
    return { entities, relations }
  })
}

// --- heuristic fallback (no LLM configured / LLM failure) ---

const STOP_WORDS = new Set([
  "的", "了", "和", "与", "是", "在", "有", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "这个", "那个", "一个", "一些", "将", "对", "中", "等", "及", "或", "被", "把", "为", "以", "从",
  "到", "于", "上", "下", "内", "外", "后", "前", "但", "而", "并", "且", "也", "都", "很", "能",
  "会", "要", "可", "不", "就", "还", "又", "其", "之", "所", "给", "让", "向", "因", "由", "当",
  "如果", "因为", "所以", "但是", "然后", "因此",
])

export function heuristicExtract(text: string): ExtractedGraph {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 4)
  const freq = new Map<string, number>()
  for (const line of lines) {
    const tokens = line.split(/[\s,，。；;：:、（）()\[\]【】"'“”‘’《》<>«»!！?？.\-—…/\\]+/)
    for (const token of tokens) {
      const t = token.trim()
      if (t.length >= 2 && t.length <= 12 && !STOP_WORDS.has(t) && !/^\d+$/.test(t)) {
        freq.set(t, (freq.get(t) ?? 0) + 1)
      }
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  return {
    entities: top.map(([name, count]) => ({ name, type: count >= 3 ? "概念" : "文档" })),
    relations: [],
  }
}
