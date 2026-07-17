# 业务系统外部认证集成设计

## 概述

将 OpenCode（AI 编程助手）以 iframe 嵌入模式集成到业务系统（bj-plus-ai-web）中。业务系统通过 iframe 携带 `Bearer token` 请求 OpenCode，OpenCode 用该 token 调业务系统 API 获取用户身份和知识目录，然后打开用户的历史会话。

## 项目背景

现有文档 `docs/knowledge-target-system-integration.md` 描述了业务系统端的改动（iframe 嵌入、`/knowledge` 路由、NGINX 代理）。本文档规划 **OpenCode 侧** 的改造方案。

## 技术栈

- **Web UI**: SolidJS + Vite
- **后端**: Effect-TS (v4 beta) + Hono-based HttpApi
- **数据库**: SQLite (Drizzle ORM)
- **认证**: HTTP Basic Auth（现有）+ External Bearer Auth（新增）

## 架构

```
业务系统 iframe (/knowledge?Authorization=Bearer <token>&clientid=<id>)
        │
        ▼ NGINX (同域名代理)
        │
┌──────────────────────────────────────────────────┐
│              OpenCode (共享实例)                    │
│                                                    │
│  /knowledge/*          → 静态资源 (Web UI SPA)      │
│  /knowledge/api/*      → Effect HttpApi            │
│                                                    │
│  中间件链路:                                         │
│  ExternalAuthMiddleware (优先)                      │
│       ↓ (失败则降级)                                 │
│  BasicAuthMiddleware (现有)                          │
│       ↓                                             │
│  LocationMiddleware (现有)                           │
│       ↓                                             │
│  SessionLocationMiddleware (现有)                    │
│                                                    │
│  新增组件:                                          │
│  - ExternalAuthMiddleware                          │
│  - ExternalIdentityAdapter                         │
│  - VirtualWorkspaceResolver                        │
│  - KnowledgeApi 路由组                               │
└──────────────────────────────────────────────────┘
```

## 组件设计

### 1. ExternalAuthMiddleware

**位置**: `packages/server/src/middleware/external-auth.ts`

在 Basic Auth 之前插入的外部认证中间件。如果 URL 携带 `Authorization=Bearer <token>` 格式的 token，走外部认证；否则降级到现有 Basic Auth。

```typescript
// Effect Context - 外部用户身份
export class ExternalIdentity extends Context.Service<
  ExternalIdentity,
  {
    userId: string
    nickName: string
    tenantId: string
    workspaces: Array<{ id: string; name: string; categories: Category[] }>
    permissions: Record<string, string[]>
  }
>()("@opencode/ExternalIdentity") {}
```

**流程**:
1. 提取 URL query 或 Header 中的 `Authorization: Bearer <token>` 和 `clientid`
2. 调用 `ExternalIdentityAdapter.authenticate(token, clientId)`
3. 成功 → 注入 ExternalIdentity 到 Effect Context
4. 失败 → 返回 401（错误码 `TOKEN_EXPIRED`）
5. 无 Bearer token → 降级到现有 Basic Auth

### 2. ExternalIdentityAdapter

**位置**: `packages/server/src/auth/external-adapter.ts`

```typescript
export interface ExternalIdentityAdapter {
  readonly authenticate: (
    token: string,
    clientId?: string,
  ) => Effect.Effect<ExternalIdentity.Info, UnauthorizedError>
}
```

**默认实现 KnowledgeAdapter** 调业务系统两步 API：

#### Step 1: 获取用户身份
```
GET {{BASE_API}}/system/user/getInfo
Header: Authorization: Bearer <token>, clientid: <clientId>
```
返回: `userId`, `nickName`, `tenantId`, `roles`, `permissions`

#### Step 2: 获取知识目录
```
GET {{BASE_API}}/system/user/getKnowledge
Header: Authorization: Bearer <token>
```
返回: 用户可访问的知识库列表 + 目录分类 + 权限

**响应格式**:
```json
{
  "code": 200,
  "data": {
    "currentWorkspaceId": "kb_001",
    "workspaces": [
      {
        "workspaceId": "kb_001",
        "workspaceName": "产品知识库",
        "workspaceType": "knowledge_base",
        "description": "产品文档、FAQ、使用指南",
        "categories": [
          { "categoryId": "cat_101", "categoryName": "产品文档", "parentId": null, "sort": 1 }
        ]
      }
    ],
    "permissions": {
      "kb_001": ["read", "write"]
    }
  }
}
```

**可扩展性**: 未来新增外部系统只需实现 `ExternalIdentityAdapter` 接口，通过 Layer 注入。

### 3. VirtualWorkspaceResolver

**位置**: `packages/core/src/location/virtual-workspace.ts`

将外部队身份 + 工作区 ID 映射为 OpenCode 的虚拟目录路径。

- 路径约定: `{dataDir}/virtual/{tenantId}/{workspaceId}/`
- 实现 `Location.Ref` 接口，兼容现有 Session 的 `directory` 查询
- 无需在磁盘上创建真实目录，仅作为逻辑隔离键

### 4. KnowledgeApi 路由组

**位置**: `packages/opencode/src/server/routes/instance/httpapi/groups/knowledge.ts`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/knowledge/api/sessions` | GET | 当前用户的历史会话列表，按 userId+tenantId 过滤 |
| `/knowledge/api/sessions/:id` | GET | 会话详情，校验归属 |
| `/knowledge/api/sessions` | POST | 创建新会话，自动附加外部身份 metadata |
| `/knowledge/api/workspaces` | GET | 当前用户可访问的知识库列表 |

这些 handler 是对现有 `session.*` handler 的封装，在 Effect Context 中已有 `ExternalIdentity`，自动附加过滤条件。

### 5. 静态资源服务

`/knowledge/*` 的非 API 路径返回 OpenCode Web UI 构建产物。入口页面启动时读取 URL 参数中的 `auth_token` 或 `Authorization`，传递给 Web UI 认证流程。

## 数据流

### 认证流
```
1. iframe 加载 /knowledge?Authorization=Bearer <token>&clientid=<id>
2. ExternalAuthMiddleware 捕获 Bearer token
3. GET /system/user/getInfo → userId, nickName, tenantId
4. GET /system/user/getKnowledge → workspaces, categories, permissions
5. ExternalIdentity 注入 Effect Context
6. VirtualWorkspaceResolver 映射虚拟目录
7. 返回 Web UI 入口页
```

### 会话查询流
```
1. Web UI 请求 /knowledge/api/sessions
2. ExternalAuthMiddleware 验证凭证
3. SessionV2.list() 查询 SQLite
   WHERE directory = '{virtualDir}'
   AND metadata->>'externalUserId' = currentUserId
4. 返回按 time_created DESC limit 50 的会话列表
```

### 会话创建流
```
1. POST /knowledge/api/sessions { agent, model, workspaceId }
2. SessionV2.create() 自动附加:
   - directory = VirtualWorkspaceResolver.resolve(...)
   - metadata.externalTenantId
   - metadata.externalUserId
   - metadata.externalNickName
   - metadata.externalWorkspaceId
3. 返回新会话 ID
```

## 数据库

利用现有 `SessionTable.metadata` 字段存储外部身份信息，**不改 schema**：

```typescript
metadata: {
  externalTenantId: "000000",
  externalUserId: "42",
  externalNickName: "管理员",
  externalWorkspaceId: "kb_001",
}
```

查询时使用 SQLite JSON 函数过滤。如果性能瓶颈出现，后续可将高频过滤字段抽出为独立列并加索引。

## 错误处理

| 场景 | HTTP 状态 | 说明 |
|------|-----------|------|
| Token 缺失 | 401 | iframe 跳转到业务系统登录页 |
| Token 过期/无效 | 401 + 错误码 `TOKEN_EXPIRED` | 可触发业务系统 token 刷新 |
| 业务系统 API 超时 | 502 | 显示"认证服务异常" |
| 无知识库权限 | 403 | 显示"没有可访问的知识库" |
| 会话越权访问 | 404 | 不暴露存在但无权访问的会话 |
| 工作区不在权限内 | 403 | — |

## 不改的范围

- 不修改现有 Session 核心数据结构
- 不修改现有 Basic Auth 认证流程（两者并存）
- 不修改现有 Web UI 组件体系
- 不增加消息队列或额外基础设施
- 不做知识库条目 CRUD（由业务系统负责）

## 测试策略

| 层级 | 覆盖内容 |
|------|---------|
| 单元测试 | ExternalIdentityAdapter token 解析、API 响应解析、错误映射 |
| 集成测试 | Mock 业务系统 API → ExternalAuthMiddleware 正确注入 |
| API 测试 | `/knowledge/api/sessions` CRUD 按 userId+tenantId 过滤 |
| 安全测试 | 越权访问、伪造 token、缺失参数 → 正确错误码 |
