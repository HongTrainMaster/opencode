import { Context, Effect, Layer } from "effect"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { InstanceStore } from "@/project/instance-store"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export interface PptGenRunResult {
  status: "SUCCESS" | "FAILED"
  /** status 为 SUCCESS 时产物 .pptx 绝对路径 */
  outputPath?: string
  error?: string
}

export interface PptGenServiceShape {
  readonly gen: (args: {
    taskId: string
    prompt: string
    /** 请求指定的模型（格式 "providerId/modelId"，如 "bjj/deepseek-v4-flash"），为空时用默认模型 */
    model?: string
    styleFileName: string
    styleContentBase64: string
  }) => Effect.Effect<PptGenRunResult>
}

export class PptGenService extends Context.Service<PptGenService, PptGenServiceShape>()(
  "@opencode/knowledge/PptGen",
) {
  static layer = Layer.effect(
    PptGenService,
    Effect.gen(function* () {
      const store: InstanceStore.Interface = yield* InstanceStore.Service
      const session: Session.Interface = yield* Session.Service
      const promptSvc: SessionPrompt.Interface = yield* SessionPrompt.Service
      return PptGenService.of({
        gen: (args) => runPptGen(store, session, promptSvc, args),
      })
    }),
  )

  static test = (gen: PptGenServiceShape["gen"]) =>
    Layer.succeed(PptGenService, PptGenService.of({ gen }))
}

const DEFAULT_PPT_MODEL = {
  providerID: ProviderV2.ID.make("hsl"),
  modelID: ModelV2.ID.make("nvidia/Qwen3.6-35B-A3B-NVFP4"),
} as const

/**
 * 解析 PPT 生成模型：请求参数 model 优先（格式 "providerId/modelId"，如 "bjj/deepseek-v4-flash"；
 * 模型 ID 自身可能含 "/"，故仅取首个 "/" 前段为 provider），未传或格式非法时回退默认模型。
 */
function resolvePptModel(requested?: string): { providerID: ProviderV2.ID; modelID: ModelV2.ID } {
  if (requested) {
    const sep = requested.indexOf("/")
    if (sep > 0 && sep < requested.length - 1) {
      const provider = requested.slice(0, sep)
      const model = requested.slice(sep + 1)
      return { providerID: ProviderV2.ID.make(provider), modelID: ModelV2.ID.make(model) }
    }
  }
  return DEFAULT_PPT_MODEL
}

const HEADLESS_RULESET: PermissionV1.Ruleset = [
  { permission: "question", action: "deny", pattern: "*" },
  { permission: "plan_enter", action: "deny", pattern: "*" },
  { permission: "plan_exit", action: "deny", pattern: "*" },
]

/** taskId 由业务端（Java 雪花ID）生成，仅允许安全文件名字符，防止路径穿越逃逸工作区 */
const TASK_ID_RE = /^[A-Za-z0-9._-]+$/

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`invalid taskId: ${JSON.stringify(taskId)}`)
  }
}

/** PPT 任务工作区根目录（服务端路径），可用环境变量覆盖 */
export function pptRoot(): string {
  return process.env.PPT_GEN_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "ppt-gen")
}

/** 技能目录：优先环境变量 PPT_SKILL_DIR（生产 systemd 配置指向真实部署路径）。
 * 编译产物中 import.meta.dir 是 bunfs 虚拟路径（/$bunfs/root/），不能定位外部脚本，
 * 故当 PPT_SKILL_DIR 未设置且 import.meta.dir 落在虚拟文件系统时，回退到工作目录下探测
 * 常见源码位置（./opencode-new/packages/opencode/src/knowledge/ppt-skill）。
 */
function skillDir(): string {
  const env = process.env.PPT_SKILL_DIR
  if (env) return env
  const meta = import.meta.dir
  if (meta && !meta.startsWith("/$bunfs")) return join(meta, "ppt-skill")
  // 编译产物回退：探测已知源码部署路径
  const cwd = process.cwd()
  const candidates = [
    join(cwd, "opencode-new", "packages", "opencode", "src", "knowledge", "ppt-skill"),
    join(cwd, "packages", "opencode", "src", "knowledge", "ppt-skill"),
    join(cwd, "src", "knowledge", "ppt-skill"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return join(cwd, "ppt-skill")
}

function buildPptPrompt(args: {
  taskId: string
  prompt: string
  skillDir: string
}): string {
  return [
    `请执行 ppt-gen 技能（技能目录：${args.skillDir}），完成一次 PPT 生成任务。`,
    ``,
    `任务ID：${args.taskId}`,
    ``,
    `用户提示词（据此生成新 PPT 的内容）：`,
    `${args.prompt}`,
    ``,
    `工作目录中已有 style.pptx（用户上传的风格参考 PPT）。请严格按以下流程：`,
    `1. 运行 python ${args.skillDir}/scripts/analyze.py style.pptx，读取输出的 JSON（重点看 slides 数组：每页的 slideIndex、layout、shapes 中每个形状的 name/type/占位符 idx/当前 text/尺寸；type=PICTURE 的是图片形状，可替换为 AI 插图）。`,
    `2. 先浏览 slides 目录，按文本内容把模板页分类：封面页（标题+单位/日期）、目录页（"目录"标题+多个目录项 shape）、过渡页（"小节标题"）、内容页（"内容页标题"+正文）、结束页（"谢谢聆听"）。记录每页 slideIndex、可替换文本的 shape 名称、PICTURE 图片形状名称。`,
    `3. 按标准 PPT 结构组织 deck.json（除非用户提示词另有要求）：封面页 → 目录页 → (过渡页 → 内容页 ×N) 分章节 → 结束页。内容分 3-6 章节，每章节 1 过渡页 + 2-4 内容页；总页数 10-16 页为宜。`,
    `4. 编写 deck.json：{"slides": [{"slideIndex": 页码, "texts": {"形状名称": "新文本"}, "images": {"PICTURE形状名称": "英文插图提示词"}}]}。要求：`,
    `   - texts 的键必须精确等于 analyze.py 输出的该页真实 shape name；逐个填入对应 shape。`,
    `   - 目录页：目录项逐个填入模板的目录项 shape（如 "Text 6"、"Text 9"、"Text 12"... 各一项），不要把多项塞进同一 shape。`,
    `   - 内容页：标题填标题 shape，正文填正文 shape；不要自创不在模板中的 shape 名。`,
    `   - images 可选：键为该页 type=PICTURE 的 shape name，值为该页主题英文插图提示词；只对内容相关大图生成，装饰性小图标不生成。`,
    `   - 结束页填致谢文字（如"谢谢聆听"）。`,
    `5. 运行 python ${args.skillDir}/scripts/build.py style.pptx deck.json output/result.pptx 构建（脚本自动复制模板页设计、替换文本、按 images 生成插图并适配目标区域、删除模板多余页）。每张插图约 40-60 秒，多图耐心等待。`,
    `6. 确认 output/result.pptx 存在、非空、页数与 deck.json 一致，且封面/目录/过渡/内容/结束页顺序正确、模板示例文字（"目录项一"等）已全部替换。`,
    ``,
    `这是无头自动化任务：不要向用户提问，不要进入 plan 模式，按上面流程直接执行并产出文件。`,
  ].join("\n")
}

function runPptGen(
  store: InstanceStore.Interface,
  session: Session.Interface,
  promptSvc: SessionPrompt.Interface,
  args: { taskId: string; prompt: string; model?: string; styleFileName: string; styleContentBase64: string },
): Effect.Effect<PptGenRunResult> {
  return Effect.gen(function* () {
    const model = resolvePptModel(args.model)
    yield* Effect.logInfo("ppt gen start", { taskId: args.taskId, model })

    // 防御：taskId 参与 workdir 拼路径，先校验字符集，非法直接失败
    yield* Effect.sync(() => assertValidTaskId(args.taskId))

    // 任务隔离子目录：ppt-root/{taskId}/
    const workdir = join(pptRoot(), args.taskId)
    yield* Effect.sync(() => mkdirSync(workdir, { recursive: true }))

    // 解码上传 .pptx 为 style.pptx（文件名固定，不取自上传文件名，防路径穿越）
    const stylePath = join(workdir, "style.pptx")
    yield* Effect.sync(() => {
      const buf = Buffer.from(args.styleContentBase64, "base64")
      if (buf.length === 0) throw new Error("style file content is empty")
      writeFileSync(stylePath, buf)
    })

    // 校验产物目录（output/ 下的 .pptx）
    const outputDir = join(workdir, "output")
    const readOutputs = (): string[] => {
      try {
        return readdirSync(outputDir).filter((f) => f.endsWith(".pptx"))
      } catch {
        return []
      }
    }
    const beforeOutputs = new Set(readOutputs())

    const prompt = buildPptPrompt({ taskId: args.taskId, prompt: args.prompt, skillDir: skillDir() })

    yield* store.provide(
      { directory: workdir },
      Effect.gen(function* () {
        const created = yield* session.create({
          title: `ppt-gen: ${args.taskId}`,
          model: { id: model.modelID, providerID: model.providerID },
          permission: HEADLESS_RULESET,
        })
        yield* Effect.logInfo("ppt session created", { sessionID: created.id, taskId: args.taskId })
        return yield* promptSvc.prompt({
          sessionID: created.id,
          model,
          parts: [{ type: "text", text: prompt }],
        })
      }),
    ).pipe(
      Effect.timeout("15 minutes"),
    )

    const newOutputs = readOutputs().filter((f) => !beforeOutputs.has(f))
    if (newOutputs.length === 0) {
      const msg = "ppt gen finished but no .pptx written under output/"
      yield* Effect.logWarning("ppt gen no output", { taskId: args.taskId, error: msg })
      return { status: "FAILED" as const, error: msg }
    }
    const outputPath = join(outputDir, newOutputs[0]!)
    yield* Effect.logInfo("ppt gen success", { taskId: args.taskId, outputPath })
    return { status: "SUCCESS" as const, outputPath }
  }).pipe(
    Effect.catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      return Effect.logError("ppt gen failed", { taskId: args.taskId, error: msg }).pipe(
        Effect.as({ status: "FAILED" as const, error: msg }),
      )
    }),
  )
}
