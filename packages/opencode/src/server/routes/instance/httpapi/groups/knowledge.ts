import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import {
  KnowledgeGraphGroup,
  KnowledgeIngestGroup,
  KnowledgeSessionGroup,
} from "@opencode-ai/protocol/groups/knowledge"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { SchemaErrorMiddleware } from "../middleware/schema-error"

export const KnowledgeApi = HttpApi.make("opencode-knowledge")
  .add(KnowledgeSessionGroup)
  .add(KnowledgeIngestGroup)
  .add(KnowledgeGraphGroup)
  .middleware(ExternalAuth)
  .middleware(SchemaErrorMiddleware)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode knowledge HttpApi",
      version: "0.0.1",
    }),
  )
