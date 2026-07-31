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