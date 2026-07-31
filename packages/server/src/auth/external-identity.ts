import { Schema, Context, Effect } from "effect"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

// --- External Identity Info (schema) ---

const Category = Schema.Struct({
  categoryId: Schema.String,
  categoryName: Schema.String,
  parentId: Schema.optional(Schema.String),
  sort: Schema.Number,
})

const Workspace = Schema.Struct({
  workspaceId: Schema.String,
  workspaceName: Schema.String,
  workspaceType: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  llmPath: Schema.optional(Schema.String),
  categories: Schema.Array(Category),
})

export const ExternalIdentityInfo = Schema.Struct({
  userId: Schema.String,
  nickName: Schema.String,
  tenantId: Schema.String,
  workspaces: Schema.Array(Workspace),
  permissions: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})
export type ExternalIdentityInfo = Schema.Schema.Type<typeof ExternalIdentityInfo>

// --- ExternalIdentity Context ---

export class ExternalIdentity extends Context.Service<
  ExternalIdentity,
  ExternalIdentityInfo
>()("@opencode/ExternalIdentity") {
  static Info = ExternalIdentityInfo
}

// --- ExternalIdentityAdapter Interface ---

export interface ExternalIdentityAdapter {
  readonly authenticate: (
    token: string,
    clientId?: string,
  ) => Effect.Effect<ExternalIdentityInfo, UnauthorizedError>
}

// --- ExternalIdentityAdapter Tag (Context key for the adapter) ---

export const ExternalIdentityAdapterTag = Context.Service<ExternalIdentityAdapter>(
  "@opencode/ExternalIdentityAdapter",
)
