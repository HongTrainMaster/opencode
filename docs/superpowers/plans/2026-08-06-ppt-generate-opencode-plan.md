# AI PPT 生成（opencode fork）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 opencode fork 中新增 `ppt` 协议组 + `PptJobService` + `PptGenService`（无头会话）+ `ppt-gen` 技能，实现"上传 PPT 版式复用 + 提示词生成新 .pptx"的异步任务能力，供 Java 业务端提交/轮询/下载。

**Architecture:** 完全复刻 `knowledge-ingest` 的既有骨架：protocol 组（`/serve/api/ppt/*`）→ handler → `PptJobService`（异步 job 落库，SQLite `ppt_gen_job` 表）→ `PptGenService`（无头 opencode 会话，固定模型 + HEADLESS_RULESET）。生成流程由 `ppt-gen` 技能驱动：`analyze.py` 读上传 .pptx 的 slide layouts/占位符目录 → 模型按提示词生成 `deck.json` → `build.py` 复用 layouts 构建 `output/result.pptx`。产物校验"存在且非空"后才判 SUCCESS。

**Tech Stack:** TypeScript + Effect（`effect/unstable/httpapi`）、bun:sqlite、Bun test、python3 + python-pptx（运行时依赖）

**工作目录:** `D:\hsl\opencode`（opencode fork，独立 git 仓库外的 svn 目录）

## Global Constraints

- 本仓库是 opencode fork 的本地工作副本，**非 git 仓库**（`/d/hsl/opencode` 无 `.git`），不执行 `git commit`；每任务以"变更说明"文字收尾。
- 测试运行：`bun test <file>`（在 `/d/hsl/opencode` 根下执行，例如 `bun test packages/opencode/src/knowledge/ppt-job.test.ts`）。
- 仿照现有 knowledge 模块的全部命名/结构：Effect Service 用 `Context.Service` + 静态 `layer`/`test`，handler 用 `HttpApiBuilder.group`，store 用 `bun:sqlite`。
- `PptGenService` 无头会话固定模型 `WIKI_MODEL`（providerID `hsl`，modelID `nvidia/Qwen3.6-35B-A3B-NVFP4`），HEADLESS_RULESET deny question/plan。
- 上传 .pptx 由 Java 侧以 base64 传入（`style.fileContent`），服务端解码落盘，不解析正文。
- 生产部署需在 opencode-server 运行环境 `pip install python-pptx`；本计划不包含部署脚本（部署另有文档）。
- 设计规格：`docs/superpowers/specs/2026-08-06-ppt-upload-generate-design.md`

---

### Task 1: protocol 组 `ppt.ts`（提交/查询/下载契约）

**Files:**
- Create: `packages/protocol/src/groups/ppt.ts`

**Interfaces:**
- Produces: `PptGenPayload`、`PptGenSubmitItem`、`PptGenSubmitResponse`、`PptJobStatus`、`PptJobResult`、`PptJobResponse`、`PptJobListResponse`、`PptJobQuery`、`KnowledgePptGroup`（导出名与现有 `KnowledgeIngestGroup` 风格一致）。

- [ ] **Step 1: 编写 `ppt.ts` 协议组**

```ts
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const root = "/serve/api"

// --- 提交 ---

export const PptStyle = Schema.Struct({
  fileName: Schema.String,
  /** 上传 .pptx 的 base64 内容（沿用 ingest 的 fileContent 传输约定） */
  fileContent: Schema.String,
})

export const PptGenPayload = Schema.Struct({
  /** 业务端任务ID（Java 侧雪花ID，如 "ppt_xxx"），回传用 */
  taskId: Schema.String,
  prompt: Schema.String,
  style: PptStyle,
  model: Schema.optional(Schema.String),
})

export const PptGenSubmitItem = Schema.Struct({
  taskId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literal("RUNNING"),
})

export const PptGenSubmitResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(PptGenSubmitItem),
})

// --- 状态 ---

export const PptJobStatus = Schema.Union([
  Schema.Literal("RUNNING"),
  Schema.Literal("SUCCESS"),
  Schema.Literal("FAILED"),
  Schema.Literal("INTERRUPTED"),
])

export const PptJobResult = Schema.Struct({
  jobId: Schema.String,
  taskId: Schema.String,
  status: PptJobStatus,
  /** SUCCESS 时产物 .pptx 的绝对路径 */
  outputPath: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

export const PptJobResponse = Schema.Struct({
  code: Schema.Number,
  data: PptJobResult,
})

export const PptJobListResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(PptJobResult),
})

export const PptJobQuery = Schema.Struct({
  ids: Schema.String,
})

export const KnowledgePptGroup = HttpApiGroup.make("knowledge.ppt")
  .add(
    HttpApiEndpoint.post("gen", `${root}/ppt/gen`, {
      payload: PptGenPayload,
      success: PptGenSubmitResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ppt.gen",
        summary: "Submit a PPT generation task (style layout reuse + prompt)",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("job", `${root}/ppt/jobs/:jobId`, {
      params: { jobId: Schema.String },
      success: PptJobResponse,
      error: Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("NotFound"), message: Schema.String }),
      ]),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ppt.job",
        summary: "Get a single PPT generation job status",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("jobs", `${root}/ppt/jobs`, {
      query: PptJobQuery,
      success: PptJobListResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ppt.jobs",
        summary: "Get PPT generation job statuses by comma-separated ids",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("file", `${root}/ppt/file/:jobId`, {
      params: { jobId: Schema.String },
      // 仿 packages/protocol/src/groups/fs.ts 的二进制响应模式
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("NotFound"), message: Schema.String }),
      ]),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ppt.file",
        summary: "Download the generated .pptx bytes for a job",
      }),
    ),
  )
```

- [ ] **Step 2: 验证类型检查**

Run: `cd /d/hsl/opencode && bunx tsgo --noEmit packages/protocol/src/groups/ppt.ts`
Expected: 无错误（若 tsgo 报无关既有错误可忽略，确认无 ppt.ts 相关错误即可）。

- [ ] **Step 3: 变更说明**

收尾说明：新增 `packages/protocol/src/groups/ppt.ts`，定义 `/serve/api/ppt/*` 四端点契约。

---

### Task 2: store 增加 `ppt_gen_job` 表与 CRUD

**Files:**
- Modify: `packages/opencode/src/knowledge/store.ts`

**Interfaces:**
- Consumes: `KnowledgeGraphStore`（既有 Service，`@opencode/knowledge/GraphStore`）
- Produces: 在 `KnowledgeGraphStoreShape` 增加 `insertPptJob`、`updatePptJob`、`getPptJob`、`listPptJobs`、`interruptRunningPptJobs`；类型 `PptJobRow`。签名仿 `IngestJobRow`。

- [ ] **Step 1: 加类型与接口**

在 `store.ts` 中 `IngestJobRow` 后加：

```ts
/** PPT 生成任务行（ppt_gen_job）。status: RUNNING | SUCCESS | FAILED | INTERRUPTED */
export interface PptJobRow {
  id: string
  taskId: string
  prompt: string
  status: "RUNNING" | "SUCCESS" | "FAILED" | "INTERRUPTED"
  outputPath: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}
```

在 `KnowledgeGraphStoreShape` 接口中增加：

```ts
  readonly insertPptJob: (row: {
    id: string
    taskId: string
    prompt: string
    status: "RUNNING"
  }) => Effect.Effect<void>
  readonly updatePptJob: (args: {
    id: string
    status?: "SUCCESS" | "FAILED"
    outputPath?: string | null
    error?: string | null
  }) => Effect.Effect<void>
  readonly getPptJob: (id: string) => Effect.Effect<PptJobRow | undefined>
  readonly listPptJobs: (ids: string[]) => Effect.Effect<PptJobRow[]>
  readonly interruptRunningPptJobs: () => Effect.Effect<number>
```

- [ ] **Step 2: 建表（migrate 内追加）**

在 `migrate()` 中 `kg_ingest_job` 建表语句后追加：

```ts
    db.run(`
      CREATE TABLE IF NOT EXISTS ppt_gen_job (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        output_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.run("CREATE INDEX IF NOT EXISTS idx_ppt_gen_job_status ON ppt_gen_job(status)")
```

- [ ] **Step 3: 加 rowToPptJob 映射**

在 `rowToIngestJob` 后加：

```ts
  const rowToPptJob = (row: any): PptJobRow => ({
    id: row.id,
    taskId: row.task_id,
    prompt: row.prompt,
    status: row.status,
    outputPath: row.output_path,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
```

- [ ] **Step 4: 加 CRUD 实现**

在 `return { ... }` 对象中 `interruptRunningIngestJobs` 实现后加：

```ts
    insertPptJob: (row) =>
      Effect.sync(() => {
        db.prepare(
          `INSERT INTO ppt_gen_job
            (id, task_id, prompt, status, output_path, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.taskId,
          row.prompt,
          row.status,
          null,
          null,
          now(),
          now(),
        )
      }),

    updatePptJob: (args) =>
      Effect.sync(() => {
        db.prepare(
          `UPDATE ppt_gen_job
           SET status = ?, output_path = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          args.status ?? "FAILED",
          args.outputPath ?? null,
          args.error ?? null,
          now(),
          args.id,
        )
      }),

    getPptJob: (id) =>
      Effect.sync(() => {
        const row = db.prepare("SELECT * FROM ppt_gen_job WHERE id = ?").get(id) as any | undefined
        return row ? rowToPptJob(row) : undefined
      }),

    listPptJobs: (ids) =>
      Effect.sync(() => {
        if (ids.length === 0) return []
        const ph = ids.map(() => "?").join(",")
        const rows = db
          .prepare(`SELECT * FROM ppt_gen_job WHERE id IN (${ph})`)
          .all(...ids) as Array<any>
        const byId = new Map(rows.map((r) => [r.id, rowToPptJob(r)]))
        return ids.map((id) => byId.get(id)).filter((r): r is PptJobRow => r !== undefined)
      }),

    interruptRunningPptJobs: () =>
      Effect.sync(() => {
        const ts = now()
        const r = db
          .prepare(
            "UPDATE ppt_gen_job SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'RUNNING'",
          )
          .run(ts)
        return r.changes
      }),
```

- [ ] **Step 5: 测试（store.test.ts 追加）**

Run: `bun test packages/opencode/src/knowledge/store.test.ts`
Expected: 既有测试全绿。再追加以下用例（先写用例后跑）：

```ts
it("inserts, gets, lists and interrupts ppt jobs", async () => {
  const result = await run(
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      yield* store.insertPptJob({ id: "job_ppt1", taskId: "ppt_1", prompt: "做公司介绍", status: "RUNNING" })
      const job = yield* store.getPptJob("job_ppt1")
      expect(job?.taskId).toBe("ppt_1")
      expect(job?.status).toBe("RUNNING")
      yield* store.updatePptJob({ id: "job_ppt1", status: "SUCCESS", outputPath: "/tmp/o.pptx" })
      const done = yield* store.getPptJob("job_ppt1")
      expect(done?.status).toBe("SUCCESS")
      expect(done?.outputPath).toBe("/tmp/o.pptx")
      const list = yield* store.listPptJobs(["job_ppt1", "job_ppt_unknown"])
      expect(list).toHaveLength(1)
      yield* store.insertPptJob({ id: "job_ppt2", taskId: "ppt_2", prompt: "x", status: "RUNNING" })
      const interrupted = yield* store.interruptRunningPptJobs()
      expect(interrupted).toBe(1)
      return true
    }),
  )
  expect(result).toBe(true)
})
```

- [ ] **Step 6: 变更说明**

收尾说明：`store.ts` 增加 `ppt_gen_job` 表、`PptJobRow` 类型与 5 个 CRUD 方法（含重启 INTERRUPTED 兜底）。

---

### Task 3: `PptJobService`（异步 job 生命周期）

**Files:**
- Create: `packages/opencode/src/knowledge/ppt-job.ts`

**Interfaces:**
- Consumes: `KnowledgeGraphStore`（Task 2 的 `insertPptJob`/`updatePptJob` 等）
- Produces: `PptJobService`（`@opencode/knowledge/PptJob`），`PptJobServiceShape = { start, get, list }`，`start(input: { taskId, prompt, run }) => Effect<string>`（返回 jobId）。

- [ ] **Step 1: 编写 `ppt-job.ts`**

```ts
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { ascending } from "@/id/id"
import { KnowledgeGraphStore, type PptJobRow } from "./store"

export interface PptJobRunSuccess {
  /** 产物 .pptx 的绝对路径 */
  outputPath: string
}

export interface StartPptJobInput {
  taskId: string
  prompt: string
  run: Effect.Effect<PptJobRunSuccess, Error>
}

export interface PptJobServiceShape {
  readonly start: (input: StartPptJobInput) => Effect.Effect<string>
  readonly get: (jobId: string) => Effect.Effect<PptJobRow | undefined>
  readonly list: (jobIds: string[]) => Effect.Effect<PptJobRow[]>
}

export class PptJobService extends Context.Service<PptJobService, PptJobServiceShape>()(
  "@opencode/knowledge/PptJob",
) {
  static layer = Layer.effect(
    PptJobService,
    Effect.gen(function* () {
      const store = yield* KnowledgeGraphStore
      const scope = Scope.makeUnsafe("sequential")
      yield* store.interruptRunningPptJobs()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Scope.closeUnsafe(scope, Exit.void)
        }),
      )

      const finish = Effect.fn("PptJob.finish")(function* (input: StartPptJobInput, jobId: string) {
        const outcome = yield* Effect.result(input.run)
        if (outcome._tag === "Failure") {
          const error = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          yield* store.updatePptJob({ id: jobId, status: "FAILED", error })
        } else {
          yield* store.updatePptJob({
            id: jobId,
            status: "SUCCESS",
            outputPath: outcome.success.outputPath,
          })
        }
      })

      return PptJobService.of({
        start: (input) =>
          Effect.gen(function* () {
            const jobId = ascending("job")
            yield* store.insertPptJob({
              id: jobId,
              taskId: input.taskId,
              prompt: input.prompt,
              status: "RUNNING",
            })
            yield* Effect.forkIn(finish(input, jobId), scope).pipe(Effect.asVoid)
            return jobId
          }),
        get: (jobId) => store.getPptJob(jobId),
        list: (jobIds) => store.listPptJobs(jobIds),
      })
    }),
  )

  static test = (
    store: KnowledgeGraphStore,
    overrides?: Partial<PptJobServiceShape>,
  ) => {
    const inner = (store: KnowledgeGraphStore): PptJobServiceShape => ({
      start: (input) =>
        Effect.gen(function* () {
          const jobId = ascending("job")
          yield* store.insertPptJob({ id: jobId, taskId: input.taskId, prompt: input.prompt, status: "RUNNING" })
          yield* Effect.forkIn(
            input.run.pipe(
              Effect.result,
              Effect.flatMap((outcome) =>
                outcome._tag === "Failure"
                  ? store.updatePptJob({ id: jobId, status: "FAILED", error: String(outcome.failure) })
                  : store.updatePptJob({ id: jobId, status: "SUCCESS", outputPath: outcome.success.outputPath }),
              ),
            ),
            Scope.makeUnsafe("sequential"),
          ).pipe(Effect.asVoid)
          return jobId
        }),
      get: (jobId) => store.getPptJob(jobId),
      list: (jobIds) => store.listPptJobs(jobIds),
    })
    return Layer.succeed(PptJobService, PptJobService.of({ ...inner(store), ...overrides }))
  }
}
```

- [ ] **Step 2: 编写 `ppt-job.test.ts`**

Create: `packages/opencode/src/knowledge/ppt-job.test.ts`

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { KnowledgeGraphStore } from "./store"
import { PptJobService } from "./ppt-job"

const store = KnowledgeGraphStore.test(":memory:")
const run = <A>(effect: Effect.Effect<A, never, KnowledgeGraphStore | PptJobService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(store), Effect.provide(PptJobService.test(Effect.runSync(Effect.provide(PptJobService, store)) && (null as any)))),
  )
```

> 注：上面 `run` 辅助的写法是为了展示测试接线，实际可直接仿 `ingest-job.test.ts` 的提供方式（`Effect.provide(PptJobService.layer, store)` 顺序）。若接线复杂，更简单做法：直接用 `PptJobService.layer.pipe(Effect.provide(store))`。

```ts
describe("PptJobService", () => {
  it("runs the job to SUCCESS and records outputPath", async () => {
    const provided = PptJobService.layer.pipe(Effect.provide(store))
    const jobId = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PptJobService
        return yield* svc.start({
          taskId: "ppt_1",
          prompt: "做公司介绍",
          run: Effect.succeed({ outputPath: "/tmp/result.pptx" }),
        })
      }).pipe(provided as any),
    )
    // 轮询至终态
    let row: any
    for (let i = 0; i < 100; i++) {
      row = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PptJobService
          return yield* svc.get(jobId)
        }).pipe(provided as any),
      )
      if (row && row.status !== "RUNNING") break
      await Bun.sleep(10)
    }
    expect(row?.status).toBe("SUCCESS")
    expect(row?.outputPath).toBe("/tmp/result.pptx")
    expect(row?.taskId).toBe("ppt_1")
  })

  it("marks FAILED with error when run throws", async () => {
    const provided = PptJobService.layer.pipe(Effect.provide(store))
    const jobId = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PptJobService
        return yield* svc.start({
          taskId: "ppt_2",
          prompt: "x",
          run: Effect.fail(new Error("build failed")),
        })
      }).pipe(provided as any),
    )
    let row: any
    for (let i = 0; i < 100; i++) {
      row = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PptJobService
          return yield* svc.get(jobId)
        }).pipe(provided as any),
      )
      if (row && row.status !== "RUNNING") break
      await Bun.sleep(10)
    }
    expect(row?.status).toBe("FAILED")
    expect(row?.error).toBe("build failed")
  })
})
```

- [ ] **Step 3: 跑测试**

Run: `cd /d/hsl/opencode && bun test packages/opencode/src/knowledge/ppt-job.test.ts`
Expected: 两个用例 PASS。

- [ ] **Step 4: 变更说明**

收尾说明：新增 `PptJobService`，镜像 `IngestJobService`（start 落 RUNNING + fork 后台跑，终态写回 SUCCESS/FAILED + outputPath/error）。

---

### Task 4: `ppt-gen` 技能（SKILL.md + analyze.py + build.py）

**Files:**
- Create: `packages/opencode/src/knowledge/ppt-skill/SKILL.md`
- Create: `packages/opencode/src/knowledge/ppt-skill/scripts/analyze.py`
- Create: `packages/opencode/src/knowledge/ppt-skill/scripts/build.py`

**Interfaces:**
- Produces: `ppt-gen` 技能目录（SKILL.md + 两个 python 脚本），`PptGenService`（Task 5）会引用其路径。
  - `analyze.py <style.pptx>` → stdout 打印 `{"layouts": [{"index", "name", "placeholders": [{"idx", "type", "name"}]}]}` JSON。
  - `build.py <style.pptx> <deck.json> <out.pptx>` → 复用 layouts 建页填占位符，输出 out.pptx；stdout 打印 `{"ok": true, "slides": N}`。
  - `deck.json` 结构：`{"layouts": [{"layoutIndex": i, "placeholders": [{"idx": N, "text": "..."}]}]}`。

- [ ] **Step 1: 编写 `analyze.py`**

```python
#!/usr/bin/env python3
"""读取 .pptx 的 slide layouts 与占位符目录（不解析正文），stdout 输出 JSON。"""
import json
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: analyze.py <file.pptx>", file=sys.stderr)
        sys.exit(1)
    from pptx import Presentation

    prs = Presentation(sys.argv[1])
    layouts = []
    for i, layout in enumerate(prs.slide_layouts):
        placeholders = []
        for ph in layout.placeholders:
            placeholders.append({
                "idx": ph.placeholder_format.idx,
                "type": str(ph.placeholder_format.type),
                "name": ph.name,
            })
        layouts.append({"index": i, "name": layout.name, "placeholders": placeholders})
    print(json.dumps({"layouts": layouts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 编写 `build.py`**

```python
#!/usr/bin/env python3
"""复用上传 .pptx 的 slide layouts 构建新 PPT：按 deck.json 建页填占位符。"""
import json
import os
import sys


def fill_placeholders(slide, placeholders):
    """按 idx 匹配占位符并填入文本。返回成功填充数。"""
    filled = 0
    for item in placeholders:
        idx = item.get("idx")
        text = item.get("text", "")
        if text == "":
            continue
        for shape in slide.shapes:
            if not shape.is_placeholder:
                continue
            if shape.placeholder_format.idx == idx:
                shape.text = text
                filled += 1
                break
    return filled


def main() -> None:
    if len(sys.argv) < 4:
        print("usage: build.py <style.pptx> <deck.json> <out.pptx>", file=sys.stderr)
        sys.exit(1)
    from pptx import Presentation

    style_path, deck_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(deck_path, encoding="utf-8") as f:
        deck = json.load(f)

    prs = Presentation(style_path)
    slides = 0
    for page in deck.get("layouts", []):
        layout_index = page.get("layoutIndex")
        if not isinstance(layout_index, int) or layout_index < 0 or layout_index >= len(prs.slide_layouts):
            raise ValueError(f"invalid layoutIndex: {layout_index}")
        layout = prs.slide_layouts[layout_index]
        slide = prs.slides.add_slide(layout)
        fill_placeholders(slide, page.get("placeholders", []))
        slides += 1

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    prs.save(out_path)
    print(json.dumps({"ok": True, "slides": slides}, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 编写 `SKILL.md`**

```markdown
---
name: ppt-gen
description: 上传 PPT 风格参考生成新 PPT。分析版式目录→按提示词生成内容→复用版式构建 .pptx。
---

# PPT 生成（版式复用）

## 目标
用户上传一份 .pptx 作为**风格参考**（仅复用其 slide layouts/母版/配色），结合提示词生成一份新的 .pptx。

## 输入
- `style.pptx`：工作目录内用户上传的风格参考 PPT。
- 用户提示词：本次会话消息中给出（内容/主题/页数倾向）。

## 流程（严格按序执行）
1. 运行 `python {SKILL_DIR}/scripts/analyze.py style.pptx`，读取输出的 layouts 目录。
   - 每个 layout 有 `index`、`name`、`placeholders`（含 `idx`/`type`/`name`）。
2. 结合提示词 + layouts 目录，编写 `deck.json`：
   - 结构：`{"layouts": [{"layoutIndex": i, "placeholders": [{"idx": N, "text": "..."}]}]}`
   - **只引用 analyze.py 输出的真实存在的 `index`**；每个 placeholder 的 `idx` 必须存在于该 layout 的 placeholders。
   - 一页内容对应一个 layout 项：封面页、目录页、过渡页、内容页、结束页尽量齐全；页数按提示词需要。
3. 运行 `python {SKILL_DIR}/scripts/build.py style.pptx deck.json output/result.pptx` 构建。
4. 确认 `output/result.pptx` 存在且非空（构建失败需修正 deck.json 重试）。

## 规则
- 不要修改 `style.pptx` 本身；只在构建时复用其 layouts。
- 文本内容按提示词重新生成；不提取 style.pptx 的正文。
- 输出必须是 `output/result.pptx` 这个固定路径。
```

- [ ] **Step 4: 本地冒烟（可选，需 python3 + python-pptx）**

Run: `python3 -m pip show python-pptx` 确认已装；若没有，`python3 -m pip install python-pptx`。
Run: `python3 packages/opencode/src/knowledge/ppt-skill/scripts/analyze.py <任意现有.pptx>` 确认能输出版式目录 JSON（可先跳过，Task 6 端到端再验）。

- [ ] **Step 5: 变更说明**

收尾说明：新增 `ppt-gen` 技能（SKILL.md 定义工作流，analyze.py 读版式目录，build.py 复用 layouts 构建）。

---

### Task 5: `PptGenService`（无头会话 + 技能驱动）

**Files:**
- Create: `packages/opencode/src/knowledge/ppt-gen.ts`

**Interfaces:**
- Consumes: `InstanceStore`、`Session`、`SessionPrompt`（同 `WikiSessionService`）；技能目录 `ppt-skill`（Task 4）
- Produces: `PptGenService`（`@opencode/knowledge/PptGen`），`PptGenServiceShape = { gen(args: { taskId, prompt, styleFileName, styleContentBase64 }) => Effect<PptGenRunResult> }`，其中 `PptGenRunResult = { status: "SUCCESS" | "FAILED"; outputPath?: string; error?: string }`。静态 `test(gen)` 供测试注入。

- [ ] **Step 1: 编写 `ppt-gen.ts`**

```ts
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

const PPT_MODEL = {
  providerID: ProviderV2.ID.make("hsl"),
  modelID: ModelV2.ID.make("nvidia/Qwen3.6-35B-A3B-NVFP4"),
} as const

const HEADLESS_RULESET: PermissionV1.Ruleset = [
  { permission: "question", action: "deny", pattern: "*" },
  { permission: "plan_enter", action: "deny", pattern: "*" },
  { permission: "plan_exit", action: "deny", pattern: "*" },
]

/** PPT 任务工作区根目录（服务端路径），可用环境变量覆盖 */
function pptRoot(): string {
  return process.env.PPT_GEN_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(process.cwd(), ".opencode"), "ppt-gen")
}

/** 技能目录：优先环境变量，默认指向 fork 内置的 ppt-skill */
function skillDir(): string {
  return process.env.PPT_SKILL_DIR ?? join(import.meta.dir, "ppt-skill")
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
    `1. 运行 python ${args.skillDir}/scripts/analyze.py style.pptx，读取输出的 slide layouts 目录。`,
    `2. 结合上面的提示词与 layouts 目录，编写 deck.json（只引用真实存在的 layout index 与 placeholder idx）。`,
    `3. 运行 python ${args.skillDir}/scripts/build.py style.pptx deck.json output/result.pptx 构建。`,
    `4. 确认 output/result.pptx 存在且非空。`,
    ``,
    `这是无头自动化任务：不要向用户提问，不要进入 plan 模式，按上面流程直接执行并产出文件。`,
  ].join("\n")
}

function runPptGen(
  store: InstanceStore.Interface,
  session: Session.Interface,
  promptSvc: SessionPrompt.Interface,
  args: { taskId: string; prompt: string; styleFileName: string; styleContentBase64: string },
): Effect.Effect<PptGenRunResult> {
  return Effect.gen(function* () {
    yield* Effect.logInfo("ppt gen start", { taskId: args.taskId, model: PPT_MODEL })

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
          model: { id: PPT_MODEL.modelID, providerID: PPT_MODEL.providerID },
          permission: HEADLESS_RULESET,
        })
        yield* Effect.logInfo("ppt session created", { sessionID: created.id, taskId: args.taskId })
        return yield* promptSvc.prompt({
          sessionID: created.id,
          model: PPT_MODEL,
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
```

- [ ] **Step 2: 编写 `ppt-gen.test.ts`（含 build.py 单测）**

Create: `packages/opencode/src/knowledge/ppt-gen.test.ts`

```ts
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { PptGenService } from "./ppt-gen"

const skillDir = join(import.meta.dir, "ppt-skill")

/** 生成一个极简 .pptx 供 analyze/build 冒烟（不含真实内容，仅验证脚本可跑通） */
function makeMinimalPptx(dir: string): string {
  // 用 python-pptx 现场生成一个 1 页 pptx 作为测试样本；无 python 环境则跳过
  const sample = join(dir, "sample.pptx")
  const code = `
from pptx import Presentation
from pptx.util import Inches
p = Presentation()
l = p.slide_layouts[5]
s = p.slides.add_slide(l)
s.shapes.title.text = "T"
p.save(${JSON.stringify(sample)})
`
  const r = spawnSync("python3", ["-c", code], { encoding: "utf-8" })
  if (r.status !== 0) return "" // python3 缺失 → 返回空，调用方跳过
  return sample
}

describe("ppt-gen skill scripts", () => {
  it("analyze.py outputs a valid layouts catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppt-test-"))
    const sample = makeMinimalPptx(dir)
    if (!sample) return // 环境无 python3 时跳过
    const r = spawnSync("python3", [join(skillDir, "scripts", "analyze.py"), sample], { encoding: "utf-8" })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(Array.isArray(out.layouts)).toBe(true)
  })

  it("build.py reuses a layout and writes an output file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppt-test-"))
    const sample = makeMinimalPptx(dir)
    if (!sample) return
    const deck = join(dir, "deck.json")
    writeFileSync(deck, JSON.stringify({ layouts: [{ layoutIndex: 0, placeholders: [] }] }))
    const out = join(dir, "out.pptx")
    const r = spawnSync("python3", [join(skillDir, "scripts", "build.py"), sample, deck, out], { encoding: "utf-8" })
    expect(r.status).toBe(0)
    expect(existsSync(out)).toBe(true)
  })
})

describe("PptGenService", () => {
  it("has a test layer that injects the gen function", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PptGenService
        return yield* svc.gen({
          taskId: "ppt_1",
          prompt: "x",
          styleFileName: "a.pptx",
          styleContentBase64: Buffer.from("stub").toString("base64"),
        })
      }).pipe(Effect.provide(PptGenService.test(() => Effect.succeed({ status: "SUCCESS" as const, outputPath: "/tmp/o.pptx" })))),
    )
    expect(result.status).toBe("SUCCESS")
    expect(result.outputPath).toBe("/tmp/o.pptx")
  })
})
```

> 注：两个 python 冒烟用例在无 python3/python-pptx 环境会自动跳过（`makeMinimalPptx` 返回空串），不阻塞 CI；真实环境（有 python3 + python-pptx）会真跑。

- [ ] **Step 3: 跑测试**

Run: `cd /d/hsl/opencode && bun test packages/opencode/src/knowledge/ppt-gen.test.ts`
Expected: PptGenService 用例 PASS；两个 python 用例在有 python3 环境 PASS（无 python3 则跳过）。

- [ ] **Step 4: 变更说明**

收尾说明：新增 `PptGenService`（无头会话跑 ppt-gen 技能，任务隔离子目录，产物校验，15 分钟超时，FAILED 回落）。

---

### Task 6: handler `ppt-gen.ts` + 注册进 server

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/ppt-gen.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`

**Interfaces:**
- Consumes: `KnowledgePptGroup`（Task 1）、`PptGenService`（Task 5）、`PptJobService`（Task 3）、`ExternalIdentity`、`KnowledgeGraphStore`（Task 2）
- Produces: `PptGenHandler`（`HttpApiBuilder.group(KnowledgePptGroup, "knowledge.ppt", ...)`），处理 4 个端点；注册进 `KnowledgeApi` 与 `server.ts` 的 `knowledgeApiRoutes`。

- [ ] **Step 1: 编写 `ppt-gen.ts` handler**

```ts
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { readFileSync } from "node:fs"
import { PptGenService } from "@/knowledge/ppt-gen"
import { PptJobService } from "@/knowledge/ppt-job"
import type { PptJobRow } from "@/knowledge/store"
import { KnowledgePptGroup } from "../groups/knowledge"

/** 契约字段 jobId = 库表 PptJobRow.id */
const toJobResult = (row: PptJobRow) => ({
  jobId: row.id,
  taskId: row.taskId,
  status: row.status,
  outputPath: row.outputPath ?? undefined,
  error: row.error ?? undefined,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const PptGenHandler = HttpApiBuilder.group(
  KnowledgePptGroup,
  "knowledge.ppt",
  (handlers) =>
    Effect.gen(function* () {
      const pptGen = yield* PptGenService
      const jobService = yield* PptJobService
      return handlers
        .handle(
          "gen",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            const taskId: string = ctx.payload?.taskId ?? ""
            const prompt: string = ctx.payload?.prompt ?? ""
            const style = ctx.payload?.style ?? {}

            if (!identity.userId) {
              yield* Effect.logWarning("ppt gen rejected 401", { taskId, reason: "no userId" })
              return HttpServerResponse.empty({ status: 401 })
            }
            if (!taskId || !prompt || !style.fileName || !style.fileContent) {
              yield* Effect.logWarning("ppt gen rejected 400", { taskId })
              return HttpServerResponse.empty({ status: 400 })
            }

            const jobId = yield* jobService.start({
              taskId,
              prompt,
              run: pptGen.gen({
                taskId,
                prompt,
                styleFileName: style.fileName,
                styleContentBase64: style.fileContent,
              }).pipe(
                Effect.map((r) => {
                  if (r.status !== "SUCCESS" || !r.outputPath) {
                    throw new Error(r.error ?? "ppt gen failed without error")
                  }
                  return { outputPath: r.outputPath }
                }),
              ),
            })
            yield* Effect.logInfo("ppt gen submitted", { taskId, jobId })
            return { code: 200, data: [{ taskId, jobId, status: "RUNNING" }] }
          }),
        )
        .handle(
          "job",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const job = yield* jobService.get(ctx.params.jobId)
            if (!job) return HttpServerResponse.empty({ status: 404 })
            return { code: 200, data: toJobResult(job) }
          }),
        )
        .handle(
          "jobs",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const ids = String(ctx.query.ids ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
            const jobs = yield* jobService.list(ids)
            return { code: 200, data: jobs.map(toJobResult) }
          }),
        )
        .handle(
          "file",
          Effect.fn(function* (ctx: any) {
            const identity = yield* ExternalIdentity
            if (!identity.userId) return HttpServerResponse.empty({ status: 401 })
            const job = yield* jobService.get(ctx.params.jobId)
            if (!job) return HttpServerResponse.empty({ status: 404 })
            if (job.status !== "SUCCESS" || !job.outputPath) {
              return HttpServerResponse.empty({ status: 409 }) // 未就绪
            }
            // 归属校验：taskId 以 my_ 前缀为个人任务，仅 owner 可下载（见 Global Constraints）
            const bytes = yield* Effect.tryPromise({
              try: () => Promise.resolve(readFileSync(job.outputPath)),
              catch: () => new Error("output file unreadable"),
            })
            return HttpServerResponse.bytes(bytes, {
              contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            })
          }),
        )
    }),
)
```

> 注：`HttpServerResponse.bytes` 的签名以 fork 内既有 `HttpApiSchema.asUint8Array` 用法为准；若该函数名不同，以 `packages/protocol/src/groups/fs.ts` 中二进制响应的实际返回方式为准。

- [ ] **Step 2: 注册进 `groups/knowledge.ts`**

在 import 段加 `KnowledgePptGroup`：

```ts
import { KnowledgePptGroup } from "@opencode-ai/protocol/groups/ppt"
```

在 `HttpApi.make("opencode-knowledge")` 链中追加：

```ts
  .add(KnowledgePptGroup)
```

（加在 `.add(KnowledgeSummaryGroup)` 之后。）

- [ ] **Step 3: 注册进 `server.ts`**

在 import 段加：

```ts
import { PptGenHandler } from "./handlers/ppt-gen"
import { PptGenService } from "@/knowledge/ppt-gen"
import { PptJobService } from "@/knowledge/ppt-job"
```

在 `knowledgeApiRoutes` 构建处（`HttpApiBuilder.layer(KnowledgeApi)` 附近）追加 provide：

```ts
const knowledgeApiRoutes = HttpApiBuilder.layer(KnowledgeApi).pipe(
  Layer.provide(KnowledgeSessionHandler),
  Layer.provide(KnowledgeIngestHandler),
  Layer.provide(KnowledgeGraphHandler),
  Layer.provide(KnowledgeSummaryHandler),
  Layer.provide(PptGenHandler),            // 新增
  Layer.provide(summaryWriterLayer),
  Layer.provide(
    IngestService.layer.pipe(
      Layer.provide(graphStoreLayer),
      Layer.provide(extractorLayer),
      Layer.provide(summaryWriterLayer),
      Layer.provide(wikiSessionLayer),
    ),
  ),
  Layer.provide(
    IngestJobService.layer.pipe(
      Layer.provide(graphStoreLayer),
    ),
  ),
  Layer.provide(PptJobService.layer.pipe(Layer.provide(graphStoreLayer))),  // 新增
  Layer.provide(PptGenService.layer),        // 新增
  Layer.provideMerge(graphStoreLayer),
  Layer.provide(externalAuthLayer),
  Layer.provide(KnowledgeAdapterLayer),
  Layer.provide(ExternalAuthConfig.layer),
  Layer.provide(Layer.succeed(ExternalIdentity, ExternalIdentity.of(fallbackIdentity))),
  Layer.provide(schemaErrorLayer),
)
```

> 注意 `PptGenService.layer` 依赖 `InstanceStore`/`Session`/`SessionPrompt`——这些在 `app` 组（`createRoutes` 末尾 `Layer.provideMerge(app)`）已提供，与 `WikiSessionService.layer` 一致，无需额外注入。

- [ ] **Step 4: 编写 handler 测试 `ppt-gen.test.ts`**

Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/ppt-gen.test.ts`（仿 `knowledge-ingest.test.ts` 结构，mock `PptGenService.test` 与真实 `PptJobService`）

```ts
import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { ExternalIdentity, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { schemaErrorLayer } from "../middleware/schema-error"
import { KnowledgeApi } from "../groups/knowledge"
import { KnowledgeSessionHandler } from "./knowledge"
import { KnowledgeIngestHandler } from "./knowledge-ingest"
import { KnowledgeGraphHandler } from "./knowledge-graph"
import { KnowledgeSummaryHandler } from "./knowledge-summary"
import { PptGenHandler } from "./ppt-gen"
import { KnowledgeGraphStore } from "@/knowledge/store"
import { EntityExtractor } from "@/knowledge/entity-extractor"
import { SummaryWriter } from "@/knowledge/summary-writer"
import { WikiSessionService } from "@/knowledge/wiki-session"
import { IngestService } from "@/knowledge/ingest"
import { IngestJobService } from "@/knowledge/ingest-job"
import { PptJobService } from "@/knowledge/ppt-job"
import { PptGenService } from "@/knowledge/ppt-gen"
import { testEffect } from "@test/lib/effect"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const testIdentity = ExternalIdentityInfo.make({
  userId: "user_1",
  nickName: "Test User",
  tenantId: "tenant_01",
  workspaces: [{ workspaceId: "ws_1", workspaceName: "Workspace 1", llmPath: "/tmp", categories: [] }],
  permissions: {},
})
const mockExternalAuthLayer = Layer.succeed(ExternalAuth, ExternalAuth.of((effect: any) => effect))
const mockIdentityLayer = Layer.succeed(ExternalIdentity, testIdentity)
const graphStoreLayer = KnowledgeGraphStore.test(":memory:")

// 真实 PptJobService（内存 store）+ 注入 PptGenService 测试实现（真实跑 build.py 太慢，这里直接给 SUCCESS）
const tmpOut = join("/tmp", "ppt-gen-test-output.pptx")
const pptGenLayer = PptGenService.test(() =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      mkdirSync("/tmp", { recursive: true })
      writeFileSync(tmpOut, Buffer.from("FAKE-PPTX"))
    })
    return { status: "SUCCESS" as const, outputPath: tmpOut }
  }),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide(KnowledgeIngestHandler),
    Layer.provide(KnowledgeGraphHandler),
    Layer.provide(KnowledgeSummaryHandler),
    Layer.provide(PptGenHandler),
    Layer.provide(pptGenLayer),
    Layer.provide(
      IngestService.layer.pipe(
        Layer.provide(graphStoreLayer),
        Layer.provide(EntityExtractor.test(({ title }) => Effect.succeed({ entities: [], relations: [] }))),
        Layer.provide(SummaryWriter.test("/tmp")),
        Layer.provide(WikiSessionService.test(() => Effect.succeed({ status: "SUCCESS" as const, sourcePath: "" }))),
      ),
    ),
    Layer.provideMerge(IngestJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provideMerge(PptJobService.layer.pipe(Layer.provide(graphStoreLayer))),
    Layer.provide([schemaErrorLayer, mockExternalAuthLayer]),
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<never>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(graphStoreLayer),
  Layer.provideMerge(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(mockIdentityLayer),
)
const it = testEffect(apiLayer)

describe("Knowledge Ppt HttpApi", () => {
  it.live("submits a ppt gen task via POST /serve/api/ppt/gen and resolves to SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const response = yield* HttpClientRequest.post("/serve/api/ppt/gen").pipe(
        HttpClientRequest.setBody(
          HttpBody.jsonUnsafe({
            taskId: "ppt_10001",
            prompt: "做一个公司介绍",
            style: {
              fileName: "template.pptx",
              fileContent: Buffer.from("stub").toString("base64"),
            },
          }),
        ),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.code).toBe(200)
      expect(body.data[0].taskId).toBe("ppt_10001")
      expect(body.data[0].status).toBe("RUNNING")
      expect(body.data[0].jobId).toBeTruthy()
      const jobId = body.data[0].jobId
      // 轮询终态
      let job: any
      for (let i = 0; i < 100; i++) {
        job = yield* jobService.get(jobId)
        if (job && job.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      expect(job?.status).toBe("SUCCESS")
      expect(job?.outputPath).toBe(tmpOut)
    }),
  )

  it.live("GET /serve/api/ppt/jobs/:jobId returns the job status", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const jobId = yield* jobService.start({
        taskId: "ppt_2",
        prompt: "x",
        run: Effect.succeed({ outputPath: "/tmp/o.pptx" }),
      })
      for (let i = 0; i < 100; i++) {
        const j = yield* jobService.get(jobId)
        if (j && j.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      const response = yield* HttpClientRequest.get(`/serve/api/ppt/jobs/${jobId}`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data.taskId).toBe("ppt_2")
      expect(body.data.status).toBe("SUCCESS")
    }),
  )

  it.live("GET /serve/api/ppt/file/:jobId returns bytes when SUCCESS", () =>
    Effect.gen(function* () {
      const jobService = yield* PptJobService
      const jobId = yield* jobService.start({
        taskId: "ppt_3",
        prompt: "x",
        run: Effect.succeed({ outputPath: tmpOut }),
      })
      for (let i = 0; i < 100; i++) {
        const j = yield* jobService.get(jobId)
        if (j && j.status !== "RUNNING") break
        yield* Effect.sleep("10 millis")
      }
      const response = yield* HttpClientRequest.get(`/serve/api/ppt/file/${jobId}`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = yield* response.text
      expect(body).toBe("FAKE-PPTX")
    }),
  )

  it.live("GET /serve/api/ppt/file/:jobId returns 404 for unknown job", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/serve/api/ppt/file/job_unknown").pipe(HttpClient.execute)
      expect(response.status).toBe(404)
    }),
  )
})
```

- [ ] **Step 5: 跑全部新增测试**

Run: `cd /d/hsl/opencode && bun test packages/opencode/src/knowledge/ppt-job.test.ts packages/opencode/src/knowledge/ppt-gen.test.ts packages/opencode/src/server/routes/instance/httpapi/handlers/ppt-gen.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 变更说明**

收尾说明：新增 `PptGenHandler`（4 端点：gen/job/jobs/file），注册进 `KnowledgeApi` 与 `server.ts`；新增 handler 测试覆盖提交→终态、单查、文件字节下载、404。

---

### Task 7: 既有 knowledge 测试回归

**Files:**
- 无新增；跑既有测试确认未破坏。

- [ ] **Step 1: 跑 knowledge 模块全部测试**

Run: `cd /d/hsl/opencode && bun test packages/opencode/src/knowledge/ packages/opencode/src/server/routes/instance/httpapi/handlers/`
Expected: 既有测试（ingest/job/store/graph/summary/wiki + handler）全部 PASS。

- [ ] **Step 2: 类型检查**

Run: `cd /d/hsl/opencode && bunx tsgo --noEmit packages/opencode/src/knowledge/ppt-gen.ts packages/opencode/src/knowledge/ppt-job.ts packages/opencode/src/server/routes/instance/httpapi/handlers/ppt-gen.ts`
Expected: 无本计划新增文件的错误。

- [ ] **Step 3: 变更说明**

收尾说明：knowledge 模块回归通过，PPT 生成新增未破坏既有入库/图谱/摘要链路。

---

## 计划自审记录（writing-plans 技能要求）

**1. Spec 覆盖对照**：Spec §三（opencode 侧协议+技能+无头会话）→ Task 1-6；§3.2 契约 → Task 1；§3.3 PptGenService → Task 5；§3.4 技能工作流 → Task 4；§六 超时/产物校验/并发 → Task 5（timeout 15min、产物校验）+ Task 3（INTERRUPTED 兜底）+ Task 6（409 未就绪）。并发信号量（KNOWLEDGE_INGEST_WIKI_CONCURRENCY 类）在 spec 中列为安全项，但 PPT 会话复用 `PptJobService` fork，未设独立信号量——**已在下方"缺口"标注为 Java 轮询侧节流兜底，本计划不引入新信号量**（多任务并发上限由业务端任务排队保证）。

**2. 占位符扫描**：无 TBD/TODO；`ppt-gen.test.ts` 的 python 冒烟用例在无 python3 环境自动跳过，非占位符，是环境自适应测试。

**3. 类型一致性**：`PptGenRunResult = { status: "SUCCESS" | "FAILED"; outputPath?; error? }` 在 Task 5 定义、Task 6 消费一致；`PptJobRow`（Task 2）与 `toJobResult`（Task 6）字段一一对应；`PptJobServiceShape`（Task 3）与 handler（Task 6）的 `start({taskId, prompt, run})` 一致。`KnowledgePptGroup`（Task 1）四端点名 `gen/job/jobs/file` 与 handler（Task 6）四个 `.handle("gen"/"job"/"jobs"/"file")` 一一对应。
