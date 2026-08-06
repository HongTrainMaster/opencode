# 知识库目标系统对接说明

> 📌 服务端部署配置（vLLM / opencode-server / 业务系统 sys_config / llm-wiki 目录）见
> [knowledge-server-deployment.md](./knowledge-server-deployment.md)。

## 概述

主系统（bj-plus-ai-web）通过 iframe 嵌入 `/knowledge` 路径，该请求经 NGINX 代理转发到目标系统（另一个独立的 Web 应用）。iframe URL 携带登录 token，目标系统需要用此 token 调主系统的接口获取用户身份和权限。

## iframe URL 格式

```
/knowledge?Authorization=Bearer <token>&clientid=<clientId>
```

| 参数 | 来源 | 说明 |
|------|------|------|
| `Authorization` | localStorage key `Admin-Token` | Bearer token，需 URL decoded 后使用 |
| `clientid` | `import.meta.env.VITE_APP_CLIENT_ID` | 客户端 ID，配置在环境变量中 |

## 主系统后端 API（目标系统需调用）

目标系统从 query 拿到 token 后，以下接口需要携带 `Authorization: Bearer <token>` Header 访问。

### 1. 获取用户身份信息 + 角色 + 权限

```
GET {{VITE_APP_BASE_API}}/system/user/getInfo
Header:
  Authorization: Bearer <token>
  clientid: <clientId>
```

**响应示例：**

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": {
    "permissions": ["*:*:*"],
    "roles": ["admin"],
    "user": {
      "userId": 1,
      "deptId": 103,
      "bmId": null,
      "unitId": null,
      "userName": "admin",
      "nickName": "管理员",
      "userType": "00",
      "email": "",
      "phonenumber": "",
      "sex": "1",
      "avatar": "",
      "status": "0",
      "loginDate": "2026-07-16T00:00:00",
      "deptName": "深圳总公司",
      "bmName": null,
      "unitName": null,
      "tenantId": "000000"
    }
  }
}
```

| 字段路径 | 说明 |
|---------|------|
| `data.user.userId` | 用户 ID |
| `data.user.userName` | 用户名 |
| `data.user.nickName` | 显示名称 |
| `data.user.deptId` | 部门 ID |
| `data.user.deptName` | 部门名称 |
| `data.user.bmId` | 部门 ID（备用） |
| `data.user.bmName` | 部门名称（备用） |
| `data.user.unitId` | 单位 ID |
| `data.user.unitName` | 单位名称 |
| `data.user.tenantId` | 租户 ID |
| `data.roles` | 角色编码数组，如 `["admin"]` |
| `data.permissions` | 权限编码数组，如 `["*:*:*"]` |

### 2. 获取动态路由菜单（按需）

```
GET {{VITE_APP_BASE_API}}/system/menu/getRouters
Header:
  Authorization: Bearer <token>
```

返回当前用户有权访问的菜单树。

## 前端页面改动记录

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/views/chat/knowledge/index.vue` | iframe 页面，加载 `/knowledge`，URL 携带 token |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/router/index.ts` | 在 `/chat` 路由下新增 `chatKnowledge` 子路由，路径 `knowledge` |
| `src/layout/chat/chat-layout.vue` | 左侧菜单新增"知识库"项，图标 `LibraryOutline` |

### 路由

- **路径**: `/chat/knowledge`
- **路由名**: `chatKnowledge`
- **布局**: 使用 chat-layout（左侧 70px 图标菜单栏）
- **iframe 目标**: `/knowledge`（由 NGINX 代理到目标系统）
