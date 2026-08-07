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

// --- 封面渲染 ---

export const PptRenderCoverPayload = Schema.Struct({
  /** 业务端任务ID（Java 侧雪花ID，如 "cover_xxx"），回传用 */
  taskId: Schema.String,
  style: PptStyle,
})

export const PptRenderCoverSubmitResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(PptGenSubmitItem),
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

/** PPT 生成进度（由技能脚本写 output/progress.json，轮询时读文件附上） */
export const PptJobProgress = Schema.Struct({
  stage: Schema.optional(Schema.String),
  totalSlides: Schema.optional(Schema.Number),
  totalPages: Schema.optional(Schema.Number),
  pagesDone: Schema.optional(Schema.Number),
  imagesTotal: Schema.optional(Schema.Number),
  imagesDone: Schema.optional(Schema.Number),
  currentImage: Schema.optional(Schema.String),
})

export const PptJobResult = Schema.Struct({
  jobId: Schema.String,
  taskId: Schema.String,
  status: PptJobStatus,
  /** SUCCESS 时产物 .pptx 的绝对路径 */
  outputPath: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  /** 生成进度（尽力而为，文件缺失/损坏时为 undefined） */
  progress: Schema.optional(PptJobProgress),
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
    HttpApiEndpoint.post("renderCover", `${root}/ppt/render-cover`, {
      payload: PptRenderCoverPayload,
      success: PptRenderCoverSubmitResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.ppt.render-cover",
        summary: "Submit a PPT cover render task (first slide → PNG via LibreOffice)",
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
      success: Schema.Uint8Array.pipe(
        HttpApiSchema.asUint8Array({
          contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      ),
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
