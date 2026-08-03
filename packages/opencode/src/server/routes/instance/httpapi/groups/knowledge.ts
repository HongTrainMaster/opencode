import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { KnowledgeIngestGroup, KnowledgeSessionGroup } from "@opencode-ai/protocol/groups/knowledge"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { SchemaErrorMiddleware } from "../middleware/schema-error"

export const KnowledgeApi = HttpApi.make("opencode-knowledge")
  .add(KnowledgeSessionGroup)
  .add(KnowledgeIngestGroup)
  .middleware(ExternalAuth)
  .middleware(SchemaErrorMiddleware)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode knowledge HttpApi",
      version: "0.0.1",
    }),
  )
