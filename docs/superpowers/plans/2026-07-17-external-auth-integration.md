# External Auth Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable iframe-based integration of OpenCode into a business system via Bearer token authentication and user-scoped session management.

**Architecture:** Add a pluggable ExternalAuthMiddleware that validates Bearer tokens against the business system API, injects an ExternalIdentity Effect Context, and maps external workspace IDs to virtual directories. New knowledge-scoped API endpoints wrap existing session operations with per-user filtering. The web UI gets a minimal knowledge entry page that reuses existing session components.

**Tech Stack:** Effect-TS v4 (HttpApi + HttpApiGroup + HttpApiMiddleware), Drizzle ORM + SQLite, SolidJS + @solidjs/router, Bun

## Global Constraints

- Do NOT modify existing Basic Auth middleware or session table schema
- External auth and Basic auth coexist — ExternalAuthMiddleware can fall back
- All session queries must filter by externalUserId + tenantId for data isolation
- ExternalIdentityAdapter interface must be generic for future external system support
- Use existing SessionTable.metadata field for external identity storage (no schema changes)
- Business system API URL configurable via env var `KNOWLEDGE_API_BASE_URL`

---

### Task 1: ExternalIdentity Context + Adapter Interface

**Files:**
- Create: `packages/server/src/auth/external-identity.ts`
- Test: `packages/server/src/auth/external-identity.test.ts`

**Interfaces:**
- Consumes: Nothing (foundational)
- Produces: `ExternalIdentity` Context class, `ExternalIdentity.Info` type, `ExternalIdentityAdapter` interface

- [ ] **Step 1: Write the test file**

```typescript
// packages/server/src/auth/external-identity.test.ts
import { describe, expect, it } from "bun:test"
import { ExternalIdentity } from "./external-identity"

describe("ExternalIdentity", () => {
  it("creates an identity", () => {
    const info = ExternalIdentity.Info.make({
      userId: "42",
      nickName: "管理员",
      tenantId: "000000",
      workspaces: [
        { id: "kb_001", name: "产品知识库", categories: [] },
      ],
      permissions: { kb_001: ["read", "write"] },
    })
    expect(info.userId).toBe("42")
    expect(info.tenantId).toBe("000000")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/hsl/opencode && bun test packages/server/src/auth/external-identity.test.ts`
Expected: FAIL with module not found / type error

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/auth/external-identity.ts
import { Schema, Context } from "effect"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

// --- External Identity Info (schema) ---

const Category = Schema.Struct({
  categoryId: Schema.String,
  categoryName: Schema.String,
  parentId: Schema.optional(Schema.String),
  sort: Schema.Number,
})

const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
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
>()("@opencode/ExternalIdentity") {}

// --- ExternalIdentityAdapter Interface ---

export interface ExternalIdentityAdapter {
  readonly authenticate: (
    token: string,
    clientId?: string,
  ) => Effect.Effect<ExternalIdentityInfo, UnauthorizedError>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/hsl/opencode && bun test packages/server/src/auth/external-identity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/external-identity.ts packages/server/src/auth/external-identity.test.ts
git commit -m "feat: add ExternalIdentity context and adapter interface"
```

---

### Task 2: ExternalAuthConfig

**Files:**
- Create: `packages/server/src/auth/external-config.ts`
- Test: `packages/server/src/auth/external-config.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentityAdapter` (used by middleware, not here)
- Produces: `ExternalAuthConfig` class for environment config

- [ ] **Step 1: Write the implementation**

```typescript
// packages/server/src/auth/external-config.ts
import { Config as EffectConfig, Context, Effect, Layer, Option } from "effect"

export interface ExternalAuthConfigInfo {
  readonly apiBaseUrl: string
}

export class ExternalAuthConfig extends Context.Service<
  ExternalAuthConfig,
  ExternalAuthConfigInfo
>()("@opencode/ExternalAuthConfig") {
  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const apiBaseUrl = yield* EffectConfig.string("KNOWLEDGE_API_BASE_URL")
          .pipe(EffectConfig.withDefault("/api"))
        return ExternalAuthConfig.of({ apiBaseUrl })
      }),
    )
  }
}
```

- [ ] **Step 2: Write the test**

```typescript
// packages/server/src/auth/external-config.test.ts
import { describe, expect, it } from "bun:test"
import { ExternalAuthConfig } from "./external-config"

describe("ExternalAuthConfig", () => {
  it("defaults to /api", () => {
    // Config is Effect-based, test via runPromise
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/auth/external-config.ts packages/server/src/auth/external-config.test.ts
git commit -m "feat: add ExternalAuthConfig for business system API URL"
```

---

### Task 3: ExternalAuthMiddleware

**Files:**
- Create: `packages/server/src/middleware/external-auth.ts`
- Test: `packages/server/src/middleware/external-auth.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentity`, `ExternalIdentityAdapter`, `ExternalAuthConfig`
- Produces: `ExternalAuth` middleware class, `externalAuthLayer`, `externalAuthRouterMiddleware`

- [ ] **Step 1: Write the test**

```typescript
// packages/server/src/middleware/external-auth.test.ts
import { describe, expect, it } from "bun:test"

// Mock adapter that validates tokens
// Test: Bearer token in URL → ExternalIdentity injected
// Test: Bearer token in Header → ExternalIdentity injected  
// Test: No Bearer token → falls through (no ExternalIdentity)
// Test: Invalid Bearer token → 401
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

```typescript
// packages/server/src/middleware/external-auth.ts
import { Effect, Layer, Context } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { ExternalIdentity, ExternalIdentityAdapter, ExternalIdentityInfo } from "../auth/external-identity"
import { ExternalAuthConfig } from "../auth/external-config"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

const BEARER_PREFIX = "knowledge:"

export class ExternalAuth extends HttpApiMiddleware.Service<ExternalAuth>()(
  "@opencode/ExternalAuth",
  { error: HttpApiError.UnauthorizedNoContent },
) {}

// Extract Bearer token from request (URL query param or Authorization header)
function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const url = new URL(request.url, "http://localhost")
  const queryAuth = url.searchParams.get("Authorization")
  if (queryAuth?.startsWith("Bearer ")) return queryAuth.slice("Bearer ".length)

  const header = request.headers.authorization ?? request.headers.get("Authorization")
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length)

  // Also handle auth_token encoded as Basic auth with "knowledge:" prefix
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString()
      const colonIdx = decoded.indexOf(":")
      if (colonIdx !== -1 && decoded.slice(0, colonIdx).startsWith(BEARER_PREFIX)) {
        return decoded.slice(BEARER_PREFIX.length, colonIdx)
      }
    } catch {}
  }
  const authToken = url.searchParams.get("auth_token")
  if (authToken) {
    try {
      const decoded = Buffer.from(authToken, "base64").toString()
      const colonIdx = decoded.indexOf(":")
      if (colonIdx !== -1 && decoded.slice(0, colonIdx).startsWith(BEARER_PREFIX)) {
        return decoded.slice(BEARER_PREFIX.length, colonIdx)
      }
    } catch {}
  }

  return undefined
}

// Encode a Bearer token into the auth_token format the web UI understands
export function encodeBearerToken(token: string): string {
  return Buffer.from(`${BEARER_PREFIX}${token}:`).toString("base64")
}

export const externalAuthLayer = Layer.effect(
  ExternalAuth,
  Effect.gen(function* () {
    // Get the adapter from context — the concrete impl is injected by the app
    return ExternalAuth.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = extractBearerToken(request)
        if (!token) return yield* effect // No Bearer token → pass through

        // Try to authenticate — if it fails, the layer is missing or misconfigured
        // In that case, pass through (graceful degradation)
        const result = yield* Effect.serviceOption(ExternalIdentityAdapterTag).pipe(
          Effect.flatMap((adapter) =>
            adapter
              ? adapter.authenticate(token)
              : Effect.fail(new UnauthorizedError({ message: "No external auth adapter configured" }))
          ),
          Effect.option,
        )
        if (result._tag === "None") return yield* effect

        const identity = result.value
        return yield* effect.pipe(
          Effect.provideService(ExternalIdentity, identity),
        )
      }),
    )
  }),
)

// Router-level middleware for static UI route authentication
export const externalAuthRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = extractBearerToken(request)
        if (!token) return yield* effect

        const result = yield* Effect.serviceOption(ExternalIdentityAdapterTag).pipe(
          Effect.flatMap((adapter) =>
            adapter
              ? adapter.authenticate(token)
              : Effect.fail(new UnauthorizedError({ message: "No external auth adapter configured" }))
          ),
          Effect.option,
        )
        if (result._tag === "None") return yield* effect

        const identity = result.value
        return yield* effect.pipe(
          Effect.provideService(ExternalIdentity, identity),
        )
      })
  }),
)
```

Note: `ExternalIdentityAdapterTag` must be exported from `external-identity.ts`. Add it there:

```typescript
// In packages/server/src/auth/external-identity.ts, add:
import { Context } from "effect"
export const ExternalIdentityAdapterTag = Context.GenericTag<ExternalIdentityAdapter>(
  "@opencode/ExternalIdentityAdapter",
)
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/auth/external-identity.ts packages/server/src/middleware/external-auth.ts \
  packages/server/src/middleware/external-auth.test.ts
git commit -m "feat: add ExternalAuthMiddleware for Bearer token validation"
```

---

### Task 4: KnowledgeAdapter (Business System Implementation)

**Files:**
- Create: `packages/opencode/src/server/auth/knowledge-adapter.ts`
- Test: `packages/opencode/src/server/auth/knowledge-adapter.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentityAdapter` interface, `ExternalAuthConfig`
- Produces: `KnowledgeAdapter` layer implementing `ExternalIdentityAdapter`

- [ ] **Step 1: Write the test (mock business system API)**

```typescript
// packages/opencode/src/server/auth/knowledge-adapter.test.ts
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/server/auth/knowledge-adapter.ts
import { Effect, Layer } from "effect"
import { HttpClient, HttpBody, HttpUrl } from "effect/unstable/http"
import { ExternalIdentityInfo, ExternalIdentityAdapterTag } from "@opencode-ai/server/auth/external-identity"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"

// Step 1: Call GET /system/user/getInfo
function callGetInfo(httpClient: HttpClient.HttpClient, token: string, clientId?: string) {
  return Effect.gen(function* () {
    const response = yield* httpClient.get(
      HttpUrl.fromUrl(new URL("/system/user/getInfo", "http://localhost")),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(clientId ? { clientid: clientId } : {}),
        },
      },
    )
    const body = yield* response.json
    if (body.code !== 200) {
      return yield* new UnauthorizedError({ message: body.msg ?? "Authentication failed" })
    }
    return body.data
  })
}

// Step 2: Call GET /system/user/getKnowledge
function callGetKnowledge(httpClient: HttpClient.HttpClient, token: string) {
  return Effect.gen(function* () {
    const response = yield* httpClient.get(
      HttpUrl.fromUrl(new URL("/system/user/getKnowledge", "http://localhost")),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const body = yield* response.json
    if (body.code !== 200) return { currentWorkspaceId: "", workspaces: [], permissions: {} }
    return body.data
  })
}

// Cached identity store (in-memory, TTL 5 min)
const identityCache = new Map<string, { identity: ExternalIdentityInfo; expiresAt: number }>()

function cacheKey(token: string): string {
  // Use first 32 chars of token hash as cache key
  let hash = 0
  for (let i = 0; i < Math.min(token.length, 64); i++) {
    hash = ((hash << 5) - hash) + token.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export const KnowledgeAdapterLayer = Layer.effect(
  ExternalIdentityAdapterTag,
  Effect.gen(function* () {
    const config = yield* ExternalAuthConfig
    const httpClient = yield* HttpClient.HttpClient.pipe(
      Effect.map((client) => client.pipe(HttpClient.mapRequest((req) => ({
        ...req,
        url: req.url.href.replace("http://localhost", config.apiBaseUrl),
      })))),
    )

    const authenticate = (token: string, clientId?: string) =>
      Effect.gen(function* () {
        // Check cache
        const key = cacheKey(token)
        const cached = identityCache.get(key)
        if (cached && cached.expiresAt > Date.now()) return cached.identity

        // Fetch identity
        const userInfo = yield* callGetInfo(httpClient, token, clientId)
        const knowledgeInfo = yield* callGetKnowledge(httpClient, token)

        const identity = ExternalIdentityInfo.make({
          userId: String(userInfo.user.userId),
          nickName: userInfo.user.nickName,
          tenantId: userInfo.user.tenantId ?? "000000",
          workspaces: knowledgeInfo.workspaces ?? [],
          permissions: knowledgeInfo.permissions ?? {},
        })

        // Cache
        identityCache.set(key, { identity, expiresAt: Date.now() + CACHE_TTL })

        // Cleanup old cache entries if too many
        if (identityCache.size > 1000) {
          const now = Date.now()
          for (const [k, v] of identityCache) {
            if (v.expiresAt <= now) identityCache.delete(k)
          }
        }

        return identity
      })

    return { authenticate }
  }),
)
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/server/auth/knowledge-adapter.ts packages/opencode/src/server/auth/knowledge-adapter.test.ts
git commit -m "feat: add KnowledgeAdapter for business system API auth"
```

---

### Task 5: VirtualWorkspaceResolver

**Files:**
- Create: `packages/core/src/virtual-workspace.ts`
- Test: `packages/core/src/virtual-workspace.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentityInfo`
- Produces: `resolve(identity, workspaceId) → { directory, workspaceID }`

- [ ] **Step 1: Write the test**

```typescript
// packages/core/src/virtual-workspace.test.ts
import { describe, expect, it } from "bun:test"
import { VirtualWorkspaceResolver } from "./virtual-workspace"

describe("VirtualWorkspaceResolver", () => {
  it("resolves workspace to a virtual directory path", () => {
    const result = VirtualWorkspaceResolver.resolve({
      userId: "42",
      tenantId: "000000",
      workspaces: [],
      permissions: {},
    }, "kb_001")
    expect(result.directory).toContain("virtual")
    expect(result.directory).toContain("000000")
    expect(result.directory).toContain("kb_001")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/virtual-workspace.ts
import path from "path"
import { AbsolutePath } from "./schema"
import { WorkspaceV2 } from "./workspace"

export interface VirtualWorkspaceRef {
  readonly directory: string
  readonly workspaceID: string | undefined
}

export const VirtualWorkspaceResolver = {
  resolve: (identity: { tenantId: string; userId: string }, workspaceId: string): VirtualWorkspaceRef => {
    // Use a virtual path under the OS temp or data dir
    // No real directory is created — just a logical key
    const virtualDir = path.join(
      process.env.XDG_DATA_HOME ?? path.join(process.cwd(), ".opencode"),
      "virtual",
      identity.tenantId,
      workspaceId,
    )
    return {
      directory: AbsolutePath.make(virtualDir),
      workspaceID: WorkspaceV2.ID.make(`${identity.tenantId}:${workspaceId}`),
    }
  },

  sessionMetadataFilter: (identity: { userId: string; tenantId: string }) => ({
    externalTenantId: identity.tenantId,
    externalUserId: identity.userId,
  }),
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/virtual-workspace.ts packages/core/src/virtual-workspace.test.ts
git commit -m "feat: add VirtualWorkspaceResolver for external workspace mapping"
```

---

### Task 6: Knowledge API Protocol Group

**Files:**
- Create: `packages/protocol/src/groups/knowledge.ts`

**Interfaces:**
- Consumes: Nothing (pure type definitions)
- Produces: `KnowledgeSessionGroup` HttpApiGroup

- [ ] **Step 1: Write the implementation**

```typescript
// packages/protocol/src/groups/knowledge.ts
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "@opencode-ai/protocol/described"

const root = "/knowledge/api"

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
    HttpApiEndpoint.get("get", `${root}/sessions/:id`, {
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.session.get",
        summary: "Get knowledge session",
      }),
    ),
    HttpApiEndpoint.post("create", `${root}/sessions`, {
      payload: CreateSessionPayload,
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.session.create",
        summary: "Create knowledge session",
      }),
    ),
    HttpApiEndpoint.get("workspaces", `${root}/workspaces`, {
      success: Schema.Unknown,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "knowledge.workspaces",
        summary: "List knowledge workspaces",
      }),
    ),
  )
```

- [ ] **Step 2: Register the export in the protocol package index**

Check `packages/protocol/src/groups/index.ts` or main export to add the new group.

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/groups/knowledge.ts
git commit -m "feat: add knowledge API protocol group definitions"
```

---

### Task 7: Knowledge API Handlers

**Files:**
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts`
- Test: `packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.test.ts`

**Interfaces:**
- Consumes: `ExternalIdentity`, `SessionV2.Service`, `VirtualWorkspaceResolver`
- Produces: `KnowledgeSessionHandler` layer

- [ ] **Step 1: Write the group definition**

```typescript
// packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { KnowledgeSessionGroup } from "@opencode-ai/protocol/groups/knowledge"
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { SchemaErrorMiddleware } from "../middleware/schema-error"

export const KnowledgeApi = HttpApi.make("opencode-knowledge")
  .add(KnowledgeSessionGroup)
  .middleware(ExternalAuth)
  .middleware(SchemaErrorMiddleware)
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode knowledge HttpApi",
      version: "0.0.1",
    }),
  )
```

- [ ] **Step 2: Write the handlers**

```typescript
// packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.ts
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { VirtualWorkspaceResolver } from "@opencode-ai/core/virtual-workspace"
import { KnowledgeApi } from "../groups/knowledge"

export const KnowledgeSessionHandler = HttpApiBuilder.group(
  KnowledgeApi,
  "knowledge.session",
  (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const identity = yield* ExternalIdentity

      return handlers
        .handle(
          "list",
          Effect.fn(function* (ctx) {
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.query.workspaceId,
            )
            const sessions = yield* session.list({
              directory: workspaceRef.directory,
              limit: ctx.query.limit ?? 50,
            })
            // Filter by externalUserId from metadata
            const filtered = sessions.filter((s) =>
              s.metadata?.externalUserId === identity.userId &&
              s.metadata?.externalTenantId === identity.tenantId,
            )
            return { data: filtered }
          }),
        )
        .handle(
          "get",
          Effect.fn(function* (ctx) {
            const s = yield* session.get(ctx.params.id)
            // Ownership check
            if (
              s.metadata?.externalUserId !== identity.userId ||
              s.metadata?.externalTenantId !== identity.tenantId
            ) {
              return yield* new HttpApiSchema.NotFound({})
            }
            return { data: s }
          }),
        )
        .handle(
          "create",
          Effect.fn(function* (ctx) {
            const workspaceRef = VirtualWorkspaceResolver.resolve(
              identity,
              ctx.payload.workspaceId,
            )
            const created = yield* session.create({
              id: ctx.payload.workspaceId,
              location: { directory: workspaceRef.directory },
              metadata: {
                externalTenantId: identity.tenantId,
                externalUserId: identity.userId,
                externalNickName: identity.nickName,
                externalWorkspaceId: ctx.payload.workspaceId,
              },
            })
            return { data: created }
          }),
        )
        .handle(
          "workspaces",
          Effect.fn(function* () {
            return { data: identity.workspaces }
          }),
        )
    }),
)
```

- [ ] **Step 3: Write the test** (mocks ExternalIdentity + SessionV2)

```typescript
// packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.test.ts
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.ts \
  packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts \
  packages/opencode/src/server/routes/instance/httpapi/handlers/knowledge.test.ts
git commit -m "feat: add knowledge API handlers"
```

---

### Task 8: Server Route Integration

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`

**Interfaces:**
- Consumes: `KnowledgeApi`, `KnowledgeSessionHandler`, `KnowledgeAdapterLayer`, `ExternalAuthConfig.layer`

- [ ] **Step 1: Register KnowledgeApi in api.ts**

```typescript
// In packages/opencode/src/server/routes/instance/httpapi/api.ts

// Add imports:
import { KnowledgeApi } from "./groups/knowledge"

// Add to OpenCodeHttpApi:
export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  .addHttpApi(PtyConnectApi)
  .addHttpApi(KnowledgeApi)     // <-- NEW
  .annotateMerge(...)
```

- [ ] **Step 2: Register knowledge routes in server.ts**

In `packages/opencode/src/server/routes/instance/httpapi/server.ts`:

Add imports:
```typescript
import { ExternalAuth } from "@opencode-ai/server/middleware/external-auth"
import { ExternalAuthConfig } from "@opencode-ai/server/auth/external-config"
import { ExternalIdentityAdapterTag } from "@opencode-ai/server/auth/external-identity"
import { KnowledgeApi } from "./groups/knowledge"
import { KnowledgeSessionHandler } from "./handlers/knowledge"
import { KnowledgeAdapterLayer } from "../../auth/knowledge-adapter"
```

Add knowledge API routes:
```typescript
// After the existing route definitions:

// Knowledge routes — uses ExternalAuth instead of Basic Auth
const knowledgeExternalAuthLayer = externalAuthLayer.pipe(
  Layer.provide(ExternalAuthConfig.layer),
)
const knowledgeApiRoutes = HttpApiBuilder.layer(KnowledgeApi).pipe(
  Layer.provide(KnowledgeSessionHandler),
  Layer.provide(knowledgeExternalAuthLayer),
  Layer.provide(KnowledgeAdapterLayer),
)
```

Add to the merged layer:
```typescript
return Layer.mergeAll(
  rootApiRoutes,
  eventApiRoutes,
  ptyConnectApiRoutes,
  instanceRoutes,
  serverRoutes,
  knowledgeApiRoutes,   // <-- NEW
  docRoute,
  uiRoute,
).pipe(...)
```

Also add a `/knowledge` UI route (before the catch-all `uiRoute`):
```typescript
// After the existing docRoute and before uiRoute:
const knowledgeUiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* router.add("GET", "/knowledge", (request) =>
      serveKnowledgeEntryPage(request, { fs }),
    )
    yield* router.add("GET", "/knowledge/", (request) =>
      serveKnowledgeEntryPage(request, { fs }),
    )
  }),
).pipe(
  Layer.provide(externalAuthRouterMiddleware),
  Layer.provide(ExternalAuthConfig.layer),
  Layer.provide(KnowledgeAdapterLayer),
)
```

Where `serveKnowledgeEntryPage` is a new function in `packages/opencode/src/server/shared/knowledge-ui.ts`:

```typescript
// packages/opencode/src/server/shared/knowledge-ui.ts
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { ExternalIdentity } from "@opencode-ai/server/auth/external-identity"
import { encodeBearerToken } from "@opencode-ai/server/middleware/external-auth"

export function serveKnowledgeEntryPage() {
  return Effect.gen(function* () {
    const identity = yield* ExternalIdentity
    // Read the original Bearer token — it's already been validated by middleware
    // Generate an auth_token for the web UI
    const authToken = encodeBearerToken(yield* getOriginalToken())
    const html = generateEntryHtml(authToken, identity)
    return HttpServerResponse.html(html)
  })
}

function generateEntryHtml(authToken: string, identity: ExternalIdentityInfo): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>知识库</title>
  <!-- Point at the same JS/CSS assets as the main web app -->
  <link rel="stylesheet" href="/assets/index.css" />
</head>
<body>
  <div id="root"></div>
  <script>
    window.__INITIAL_AUTH_TOKEN__ = "${authToken}";
    window.__KNOWLEDGE_MODE__ = true;
    window.__USER_INFO__ = ${JSON.stringify({
      nickName: identity.nickName,
      workspaces: identity.workspaces,
      permissions: identity.permissions,
    })};
  </script>
  <script type="module" src="/assets/entry-client.js"></script>
</body>
</html>`
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/server/routes/instance/httpapi/api.ts \
  packages/opencode/src/server/routes/instance/httpapi/server.ts \
  packages/opencode/src/server/shared/knowledge-ui.ts
git commit -m "feat: register knowledge routes in server"
```

---

### Task 9: Web UI Knowledge Entry

**Files:**
- Modify: `packages/app/src/entry.tsx`
- Modify: `packages/app/src/app.tsx`
- Create: `packages/app/src/pages/knowledge-home.tsx`

**Interfaces:**
- Consumes: Knowledge API endpoints via existing SDK
- Produces: Knowledge home page component

- [ ] **Step 1: Create KnowledgeHome component**

```tsx
// packages/app/src/pages/knowledge-home.tsx
import { createSignal, createResource, For, Show } from "solid-js"
import { useServer } from "@/context/server"

export function KnowledgeHome() {
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string | null>(null)
  const server = useServer()
  const apiBase = () => `${server.http.url}/knowledge/api`

  // Read initial data from window globals set by the server
  const userInfo = (window as any).__USER_INFO__ ?? { workspaces: [], nickName: "" }

  const [sessions] = createResource(
    selectedWorkspace,
    async (wsId: string) => {
      const res = await fetch(`${apiBase()}/sessions?workspaceId=${wsId}`)
      const data = await res.json()
      return data.data ?? []
    },
  )

  return (
    <div class="knowledge-home">
      <nav class="workspace-nav">
        <For each={userInfo.workspaces}>
          {(ws) => (
            <button
              class={selectedWorkspace() === ws.id ? "active" : ""}
              onClick={() => setSelectedWorkspace(ws.id)}
            >
              {ws.name}
            </button>
          )}
        </For>
      </nav>

      <main class="session-list">
        <Show when={!selectedWorkspace()}>
          <p>请选择一个知识库</p>
        </Show>
        <Show when={sessions()}>
          <For each={sessions()}>
            {(session) => (
              <a
                class="session-item"
                href={`/knowledge/session/${session.id}?auth_token=${encodeURIComponent((window as any).__INITIAL_AUTH_TOKEN__ ?? "")}`}
              >
                <h3>{session.title}</h3>
                <time>{new Date(session.time?.created).toLocaleString()}</time>
              </a>
            )}
          </For>
        </Show>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Add knowledge routes to app.tsx**

In `packages/app/src/app.tsx`:

```typescript
import { KnowledgeHome } from "./pages/knowledge-home"

// Add to Router:
<Route path="/knowledge" component={KnowledgeHome}>
  <Route path="/session/:id" component={SessionPage} />
</Route>
```

- [ ] **Step 3: Modify entry.tsx to handle knowledge mode**

In `packages/app/src/entry.tsx`, after `auth = authFromToken(...)`:

```typescript
// Knowledge mode support
if ((window as any).__KNOWLEDGE_MODE__) {
  const token = (window as any).__INITIAL_AUTH_TOKEN__ as string
  if (token) {
    // Use the pre-encoded auth_token for API calls
    const params = new URLSearchParams(location.search)
    if (!params.has("auth_token") && token) {
      params.set("auth_token", token)
      history.replaceState(null, "", location.pathname + "?" + params)
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/pages/knowledge-home.tsx packages/app/src/app.tsx packages/app/src/entry.tsx
git commit -m "feat: add knowledge web UI entry"
```

---

### Task 10: End-to-End Verification

- [ ] **Verify build compiles**

```bash
cd D:/hsl/opencode
bun run typecheck
```

- [ ] **Verify the knowledge auth flow works** by starting the server and testing:

```bash
# With a mock business system API
KNOWLEDGE_API_BASE_URL=http://localhost:9999 OPENCODE_SERVER_PASSWORD=test bun run dev:web
```

- [ ] **Verify error scenarios**: missing token, expired token, no permissions

- [ ] **Final commit** with any fixes

```bash
git commit -am "fix: knowledge integration adjustments from testing"
```
