# opencode 生成 PPTX 功能 — 业务系统对接说明

> 功能：业务系统上传一份 `.pptx` 作为**风格参考**（仅复用其 slide layouts/母版/配色），结合提示词，由 opencode 无头会话调用 `ppt-gen` 技能（python-pptx）异步生成一份新的 `.pptx`，完成后业务系统下载产物。
>
> 服务端部署：见 [knowledge-server-deployment.md](./knowledge-server-deployment.md)；生产需在 opencode-server 运行环境安装 `python-pptx`（`pip install python-pptx`）。

## 鉴权

所有接口需携带 `Authorization: Bearer <JWT>` Header（与入库/知识库接口一致）。JWT 由业务系统签发，opencode 解码 payload 中的 `userId`/`userName`/`tenantId`。

```http
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
```

- 无 userId（token 缺失或无效）→ **401**
- 参数缺失 → **400**

## 接口总览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/serve/api/ppt/gen` | 提交 PPT 生成任务（异步，立即返回 jobId） |
| GET | `/serve/api/ppt/jobs/:jobId` | 查询单个任务状态与结果 |
| GET | `/serve/api/ppt/jobs?ids=a,b` | 批量查询（按传入顺序返回） |
| GET | `/serve/api/ppt/file/:jobId` | 下载生成的 `.pptx`（仅 SUCCESS 可下载） |

---

## 1. 提交生成任务

```
POST /serve/api/ppt/gen
Content-Type: application/json
```

### 请求体

```json
{
  "taskId": "ppt_2084990000000000001",
  "prompt": "做一个公司年度总结 PPT，封面、目录、内容、结束页，约 8 页",
  "style": {
    "fileName": "公司模板.pptx",
    "fileContent": "<上传 .pptx 文件的 base64 内容>"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 业务系统任务 ID（如雪花 ID），回传用；建议唯一 |
| `prompt` | string | 是 | 生成提示词（主题/内容/页数倾向） |
| `style.fileName` | string | 是 | 风格参考文件名（仅用于记录，服务端固定存为 `style.pptx` 防路径穿越） |
| `style.fileContent` | string | 是 | 风格参考 `.pptx` 的 base64 内容 |
| `model` | string | 否 | 预留，暂未使用 |

### 响应（立即返回，异步执行）

```json
{
  "code": 200,
  "data": [
    {
      "taskId": "ppt_2084990000000000001",
      "jobId": "job_a1B2c3D4...",
      "status": "RUNNING"
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `data[].taskId` | 回传业务系统任务 ID |
| `data[].jobId` | opencode 任务 ID，后续轮询/下载用 |
| `data[].status` | 恒为 `RUNNING`（提交即后台执行） |

---

## 2. 查询任务状态

### 单查

```
GET /serve/api/ppt/jobs/:jobId
```

### 批量查

```
GET /serve/api/ppt/jobs?ids=job_a1B2c3D4...,job_xYz...
```

`ids` 逗号分隔，按传入顺序返回；未知 jobId 在批量查询中跳过、单查返回 **404**。

### 响应

```json
{
  "code": 200,
  "data": {
    "jobId": "job_a1B2c3D4...",
    "taskId": "ppt_2084990000000000001",
    "status": "SUCCESS",
    "outputPath": "/home/bjglj/.opencode/ppt-gen/ppt_2084990000000000001/output/result.pptx",
    "error": null,
    "createdAt": "2026-08-06T07:00:00.000Z",
    "updatedAt": "2026-08-06T07:05:00.000Z"
  }
}
```

### `data.status` 取值与含义

| status | 含义 | 业务处理建议 |
|--------|------|--------------|
| `RUNNING` | 后台生成中 | 继续轮询（建议间隔 3-10 秒） |
| `SUCCESS` | 生成完成，可下载 | 调 `/serve/api/ppt/file/:jobId` 下载 |
| `FAILED` | 生成失败 | 读 `data.error` 提示用户，可修改提示词重试 |
| `INTERRUPTED` | 服务重启时任务中断（未完成） | 可重新提交 |

> 业务侧建议：`RUNNING` 轮询超过设定超时（如 15 分钟，服务端生成会话超时上限）仍未终态时，提示用户稍后重试。任务并发上限建议由业务系统排队控制。

---

## 3. 下载生成的 PPTX

```
GET /serve/api/ppt/file/:jobId
```

| 场景 | 返回 |
|------|------|
| 成功（status=SUCCESS） | 200，body 为 `.pptx` 二进制，Content-Type `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| 任务不存在 | 404 |
| 任务未就绪（非 SUCCESS） | 409 |
| 未认证 | 401 |

> 前端可用 `response.blob()` 转成下载链接；后端可用 `InputStream` 直接返回给客户端。

---

## 业务系统推荐调用时序

```
1. POST /serve/api/ppt/gen        → 拿到 jobId（RUNNING）
2. 轮询 GET /serve/api/ppt/jobs/:jobId
     - RUNNING   → 间隔数秒继续
     - SUCCESS   → 进入步骤 3
     - FAILED    → 展示 error，结束
     - INTERRUPTED → 提示重新提交
3. GET /serve/api/ppt/file/:jobId → 下载 .pptx，展示给用户
```

---

## 错误码汇总

| HTTP 状态 | 场景 |
|-----------|------|
| 200 | 成功（提交/查询/下载） |
| 400 | 参数缺失（无 `taskId`/`prompt`/`style.fileName`/`style.fileContent`） |
| 401 | 未认证（token 缺失或 JWT 无 userId） |
| 404 | 单查/下载未知 jobId |
| 409 | 下载时任务未完成（非 SUCCESS） |

## 部署前置

- opencode-server 运行环境需安装 Python 3 + `python-pptx`：`pip install python-pptx`。
- 生成产物默认落盘在 `{XDG_DATA_HOME 或 .opencode}/ppt-gen/{taskId}/output/result.pptx`，可用环境变量 `PPT_GEN_ROOT` 覆盖根目录。
