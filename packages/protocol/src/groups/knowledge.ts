import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const root = "/serve/api"

export const KnowledgeSessionListQuery = Schema.Struct({
  workspaceId: Schema.String,
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
})

export const CreateSessionPayload = Schema.Struct({
  agent: Schema.optional(Schema.String),
  model: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      providerID: Schema.String,
    }),
  ),
  workspaceId: Schema.String,
})

export const KnowledgeSessionGroup = HttpApiGroup.make("knowledge.session")
  .add(
    HttpApiEndpoint.get("list", `${root}/sessions`, {
      query: KnowledgeSessionListQuery,
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.session.list",
        summary: "List knowledge sessions",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("create", `${root}/sessions`, {
      payload: CreateSessionPayload,
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.session.create",
        summary: "Create knowledge session",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workspaces", `${root}/workspaces`, {
      success: Schema.Struct({ data: Schema.Any }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.workspaces",
        summary: "List knowledge workspaces",
      }),
    ),
  )

// ===========================================================================
// Ingest（契约基准第 4 节；JSON body + base64 fileContent）
// ===========================================================================

export const IngestOperation = Schema.Union([
  Schema.Literal("CREATE"),
  Schema.Literal("UPDATE"),
  Schema.Literal("DELETE"),
])

export const IngestDocument = Schema.Struct({
  documentId: Schema.String,
  title: Schema.String,
  categoryId: Schema.optional(Schema.String),
  llmPath: Schema.optional(Schema.String),
  secretLevel: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  operation: IngestOperation,
  fileContent: Schema.optional(Schema.String),
})

export const IngestPayload = Schema.Struct({
  workspaceId: Schema.String,
  documents: Schema.Array(IngestDocument),
})

export const IngestResultItem = Schema.Struct({
  documentId: Schema.String,
  status: Schema.Union([Schema.Literal("SUCCESS"), Schema.Literal("FAILED")]),
  entities: Schema.Number,
  relations: Schema.Number,
  summary: Schema.optional(Schema.Union([Schema.Literal("SUCCESS"), Schema.Literal("SKIPPED")])),
  error: Schema.optional(Schema.String),
})

export const IngestResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Array(IngestResultItem),
})

export const KnowledgeIngestGroup = HttpApiGroup.make("knowledge.ingest").add(
  HttpApiEndpoint.post("ingest", `${root}/ingest`, {
    payload: IngestPayload,
    success: IngestResponse,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "knowledge.ingest",
      summary: "Ingest a document into the knowledge graph (CREATE/UPDATE/DELETE)",
    }),
  ),
)

// ===========================================================================
// Graph query（供主系统转发展示；个人图谱按 owner 隔离）
// ===========================================================================

export const GraphEntity = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  sourceDocumentId: Schema.String,
  scope: Schema.String,
  ownerId: Schema.String,
  status: Schema.String,
})

export const GraphRelation = Schema.Struct({
  id: Schema.String,
  headEntityId: Schema.String,
  tailEntityId: Schema.String,
  relationType: Schema.String,
  confidence: Schema.Number,
  source: Schema.String,
})

export const GraphEntitiesQuery = Schema.Struct({
  documentId: Schema.String,
})

export const GraphRelationsQuery = Schema.Struct({
  entityId: Schema.String,
  hops: Schema.optional(Schema.NumberFromString),
})

export const GraphEntityListResponse = Schema.Struct({
  data: Schema.Array(GraphEntity),
})

export const GraphRelationListResponse = Schema.Struct({
  data: Schema.Array(GraphRelation),
})

export const GraphEntityDetailResponse = Schema.Struct({
  data: GraphEntity,
})

export const GraphWorkspaceQuery = Schema.Struct({
  workspaceId: Schema.String,
})

export const GraphWorkspaceResponse = Schema.Struct({
  data: Schema.Struct({
    entities: Schema.Array(GraphEntity),
    relations: Schema.Array(GraphRelation),
  }),
})

export const KnowledgeGraphGroup = HttpApiGroup.make("knowledge.graph")
  .add(
    HttpApiEndpoint.get("entities", `${root}/graph/entities`, {
      query: GraphEntitiesQuery,
      success: GraphEntityListResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.graph.entities",
        summary: "List graph entities for a document",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("relations", `${root}/graph/relations`, {
      query: GraphRelationsQuery,
      success: GraphRelationListResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.graph.relations",
        summary: "List graph relations for an entity (1 or 2 hops)",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("entity", `${root}/graph/entity/:id`, {
      params: { id: Schema.String },
      success: GraphEntityDetailResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.graph.entity",
        summary: "Get a single graph entity by id",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("workspace", `${root}/graph/workspace`, {
      query: GraphWorkspaceQuery,
      success: GraphWorkspaceResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.graph.workspace",
        summary: "List all graph entities and relations for a workspace",
      }),
    ),
  )

// ===========================================================================
// Summary（供主系统查看/编辑 opencode 生成的 AI 摘要 MD）
// llmPath 由主系统计算后传入；opencode 只做 sanitize + 拼路径 + 读写
// ===========================================================================

export const SummaryReadQuery = Schema.Struct({
  llmPath: Schema.String,
  documentId: Schema.String,
})

export const SummaryReadResponse = Schema.Struct({
  exists: Schema.Boolean,
  content: Schema.optional(Schema.NullOr(Schema.String)),
})

export const SummaryWritePayload = Schema.Struct({
  llmPath: Schema.String,
  documentId: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
})

export const SummaryWriteResponse = Schema.Struct({
  documentId: Schema.String,
  status: Schema.Literal("SUCCESS"),
  error: Schema.optional(Schema.String),
})

export const KnowledgeSummaryGroup = HttpApiGroup.make("knowledge.summary")
  .add(
    HttpApiEndpoint.get("list", `${root}/summary`, {
      query: SummaryReadQuery,
      success: SummaryReadResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.summary.list",
        summary: "Read a document's AI summary source file",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("write", `${root}/summary`, {
      payload: SummaryWritePayload,
      success: SummaryWriteResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.summary.write",
        summary: "Write (create or overwrite) a document's AI summary source file",
      }),
    ),
  )