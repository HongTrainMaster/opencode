import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpBody, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { ExternalIdentity, ExternalIdentityInfo } from "@opencode-ai/server/auth/external-identity"
import { SessionV2, SessionSchema } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { schemaErrorLayer } from "../middleware/schema-error"
import { KnowledgeApi } from "../groups/knowledge"
import { KnowledgeSessionHandler } from "./knowledge"
import { testEffect } from "@test/lib/effect"

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const now = DateTime.makeUnsafe(Date.now())

const testIdentity = ExternalIdentityInfo.make({
  userId: "user_1",
  nickName: "Test User",
  tenantId: "tenant_01",
  workspaces: [
    { workspaceId: "ws_1", workspaceName: "Workspace 1", categories: [] },
  ],
  permissions: {},
})

const mockSessionOwned = SessionSchema.Info.make({
  id: SessionV2.ID.make("ses_owned"),
  projectID: ProjectV2.ID.make("prj_test"),
  title: "My Session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: AbsolutePath.make("/virtual/test") },
  metadata: { externalUserId: "user_1", externalTenantId: "tenant_01" },
})

const mockSessionOther = SessionSchema.Info.make({
  id: SessionV2.ID.make("ses_other"),
  projectID: ProjectV2.ID.make("prj_test"),
  title: "Other Session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: AbsolutePath.make("/virtual/test") },
  metadata: { externalUserId: "user_2", externalTenantId: "tenant_02" },
})

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const mockSessionLayer = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    list: () => Effect.succeed([mockSessionOwned, mockSessionOther]),
    get: (id) => {
      if (id === "ses_owned") return Effect.succeed(mockSessionOwned)
      if (id === "ses_other") return Effect.succeed(mockSessionOther)
      return Effect.fail(new SessionV2.NotFoundError({ sessionID: id }))
    },
    create: () => Effect.succeed(mockSessionOwned),
    messages: () => Effect.die("not implemented") as any,
    message: () => Effect.die("not implemented") as any,
    context: () => Effect.die("not implemented") as any,
    events: () => Effect.die("not implemented") as any,
    history: () => Effect.die("not implemented") as any,
    switchAgent: () => Effect.die("not implemented") as any,
    switchModel: () => Effect.die("not implemented") as any,
    prompt: () => Effect.die("not implemented") as any,
    shell: () => Effect.die("not implemented") as any,
    skill: () => Effect.die("not implemented") as any,
    compact: () => Effect.die("not implemented") as any,
    wait: () => Effect.die("not implemented") as any,
    resume: () => Effect.die("not implemented") as any,
    interrupt: () => Effect.die("not implemented") as any,
    revert: {
      stage: () => Effect.die("not implemented") as any,
      clear: () => Effect.die("not implemented") as any,
      commit: () => Effect.die("not implemented") as any,
    },
    active: Effect.die("not implemented") as any,
  }),
)

const mockExternalAuthLayer = Layer.succeed(
  ExternalAuth,
  ExternalAuth.of((effect: any) => effect),
)

const mockIdentityLayer = Layer.succeed(
  ExternalIdentity,
  testIdentity,
)

// ---------------------------------------------------------------------------
// Build the HTTP layer
// ---------------------------------------------------------------------------

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(KnowledgeApi).pipe(
    Layer.provide(KnowledgeSessionHandler),
    Layer.provide([schemaErrorLayer, mockExternalAuthLayer]),
    HttpRouter.provideRequest(
      Layer.succeedContext(Context.empty() as Context.Context<never>),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(mockSessionLayer),
  Layer.provide(mockIdentityLayer),
)

const it = testEffect(apiLayer)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Knowledge HttpApi", () => {
  it.live("lists sessions filtered by user ownership", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        "/knowledge/api/sessions?workspaceId=ws_1",
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      // Should only include sessions owned by the test user
      expect(body.data).toHaveLength(1)
      expect(body.data[0].id).toBe("ses_owned")
    }),
  )

  it.live("gets a session the caller owns", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        "/knowledge/api/sessions/ses_owned",
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data.id).toBe("ses_owned")
    }),
  )

  it.live("returns 404 for a session owned by someone else", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        "/knowledge/api/sessions/ses_other",
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(404)
    }),
  )

  it.live("returns 404 for a non-existent session", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        "/knowledge/api/sessions/ses_nonexistent",
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(404)
    }),
  )

  it.live("creates a knowledge session with metadata", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/knowledge/api/sessions")
        .pipe(
          HttpClientRequest.setBody(
            HttpBody.jsonUnsafe({ workspaceId: "ws_1" }),
          ),
          HttpClient.execute,
        )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data.id).toBe("ses_owned")
    }),
  )

  it.live("lists workspaces from the identity", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        "/knowledge/api/workspaces",
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as any
      expect(body.data).toHaveLength(1)
      expect(body.data[0].workspaceId).toBe("ws_1")
    }),
  )
})
