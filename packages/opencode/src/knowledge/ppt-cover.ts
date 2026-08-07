import { Context, Effect, Layer, Semaphore } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** taskId 由业务端（Java 雪花ID）生成，仅允许安全文件名字符，防止路径穿越逃逸工作区 */
const TASK_ID_RE = /^[A-Za-z0-9._-]+$/

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`invalid taskId: ${JSON.stringify(taskId)}`)
  }
}

const execFileAsync = promisify(execFile)

export interface PptCoverRunResult {
  status: "SUCCESS" | "FAILED"
  /** status 为 SUCCESS 时封面 PNG 绝对路径 */
  outputPath?: string
  error?: string
}

export interface PptCoverServiceShape {
  readonly render: (args: {
    taskId: string
    styleFileName: string
    styleContentBase64: string
  }) => Effect.Effect<PptCoverRunResult>
}

export class PptCoverService extends Context.Service<PptCoverService, PptCoverServiceShape>()(
  "@opencode/knowledge/PptCover",
) {
  static layer = Layer.effect(
    PptCoverService,
    Effect.gen(function* () {
      // 并发上限：防多模板并发打爆 soffice（对齐 ingest 的 KNOWLEDGE_INGEST_WIKI_CONCURRENCY）
      const conc = Number(process.env.PPT_COVER_CONCURRENCY ?? "2")
      const semaphore = yield* Semaphore.make(Math.max(1, Number.isFinite(conc) ? conc : 2))
      return PptCoverService.of({
        render: (args) => semaphore.withPermits(1)(runPptCover(args)),
      })
    }),
  )

  static test = (render: PptCoverServiceShape["render"]) =>
    Layer.succeed(PptCoverService, PptCoverService.of({ render }))
}

/** 封面任务工作区根目录（服务端路径），可用环境变量覆盖 */
function coverRoot(): string {
  return process.env.PPT_COVER_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "ppt-cover")
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

function runPptCover(args: {
  taskId: string
  styleFileName: string
  styleContentBase64: string
}): Effect.Effect<PptCoverRunResult> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("ppt cover start", { taskId: args.taskId })

    // 防御：taskId 参与 workdir 拼路径，先校验字符集，非法直接失败
    yield* Effect.sync(() => assertValidTaskId(args.taskId))

    // 任务隔离子目录：cover-root/{taskId}/
    const workdir = join(coverRoot(), args.taskId)
    yield* Effect.sync(() => mkdirSync(workdir, { recursive: true }))

    // 解码上传 .pptx 为 style.pptx（文件名固定，不取自上传文件名，防路径穿越）
    const stylePath = join(workdir, "style.pptx")
    yield* Effect.sync(() => {
      const buf = Buffer.from(args.styleContentBase64, "base64")
      if (buf.length === 0) throw new Error("style file content is empty")
      writeFileSync(stylePath, buf)
    })

    const coverPath = join(workdir, "cover.png")
    const script = join(skillDir(), "scripts", "render_cover.py")
    // 异步 spawn：非零退出/找不到二进制会 reject（Error 携带 stderr），交给外层 catch 转 FAILED；
    // 这里不阻塞事件循环，让并发信号量真正限制同时运行的 soffice 进程数。
    yield* Effect.tryPromise({
      try: () => execFileAsync("python3", [script, stylePath, coverPath], { timeout: 240_000 }),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    })
    // python 可能以 0 退出但未写出文件，单独兜底
    if (!existsSync(coverPath)) {
      const msg = "render_cover finished but no cover.png written"
      yield* Effect.logWarning("ppt cover failed", { taskId: args.taskId, error: msg })
      return { status: "FAILED" as const, error: msg }
    }
    yield* Effect.logInfo("ppt cover success", { taskId: args.taskId, outputPath: coverPath })
    return { status: "SUCCESS" as const, outputPath: coverPath }
  }).pipe(
    Effect.catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      return Effect.logError("ppt cover error", { taskId: args.taskId, error: msg }).pipe(
        Effect.as({ status: "FAILED" as const, error: msg }),
      )
    }),
  )
}
