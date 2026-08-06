# Docs

本项目（知识库入库 / opencode 集成）相关文档索引。

## 部署与配置

| 文档 | 说明 | 使用场景 |
|---|---|---|
| [knowledge-server-deployment.md](./knowledge-server-deployment.md) | **服务端部署配置说明**：vLLM、opencode-server（provider/limit/permission）、业务系统 `sys_config` 与 `km_category.llm_path`、llm-wiki 目录要求、入库状态流转与手动重触发、常见故障排查表 | 部署/迁移到新环境时必须阅读 |
| [knowledge-target-system-integration.md](./knowledge-target-system-integration.md) | 知识库目标系统对接：iframe URL、token 传递、主系统后端 API（getInfo/getRouters）、前端改动记录 | 前端/后端对接目标系统 |
| [deploy-todo.md](./deploy-todo.md) | 部署待办（2026-08-02 生成）：服务器信息、编译/重启/前端 SPA 部署流程 | 一次性部署操作清单 |

## 设计与方案

| 文档 | 说明 |
|---|---|
| [superpowers/plans/2026-07-17-external-auth-integration.md](./superpowers/plans/2026-07-17-external-auth-integration.md) | 外部认证（JWT）集成方案 |
| [superpowers/specs/2026-07-17-external-auth-integration-design.md](./superpowers/specs/2026-07-17-external-auth-integration-design.md) | 外部认证集成设计 |
| [superpowers/specs/2026-07-21-default-local-search-prompt.md](./superpowers/specs/2026-07-21-default-local-search-prompt.md) | 默认本地搜索提示词设计 |
| [superpowers/plans/2026-08-04-async-ingest.md](./superpowers/plans/2026-08-04-async-ingest.md) | 异步 ingest 方案 |
| [superpowers/specs/2026-08-04-async-ingest-design.md](./superpowers/specs/2026-08-04-async-ingest-design.md) | 异步 ingest 设计（HTTP 协议：`POST /serve/api/ingest` 提交、`GET /serve/api/ingest/jobs/:jobId` 查询、`GET /serve/api/ingest/jobs?ids=...` 批量查询） |
