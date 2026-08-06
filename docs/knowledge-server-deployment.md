# 知识库入库服务端部署配置说明

> 目的：将知识库入库（ingest → 实体/关系图 → llm-wiki 会话 → summary）正确部署到新环境时，本机 / 服务端需要完成的全部配置。
> 适用：主系统（ruoyi-vue-plus 系）通过 `km_ingest_log` 通知 opencode 执行入库的部署形态。

## 一、架构总览

```
业务系统 (Java ruoyi-admin :8080)
    │  HTTP+JWT  (POST /serve/api/ingest)
    ▼
opencode-server (:4096)          ← headless 服务，跑 ingest / wiki 会话
    │  AI SDK  (provider=hsl)
    ▼
vLLM (:8000)                     ← 推理服务，模型 Qwen3.6-35B-A3B-NVFP4
    ▲
llm-wiki 知识库目录              ← wiki/sources、wiki/entities 落盘
```

| 组件 | 端口 | 说明 |
|---|---|---|
| 业务系统 | 8080 | ruoyi-admin.jar，负责入库通知、状态轮询同步 |
| opencode-server | 4096 | opencode 后端服务（headless），提供 `/serve/api/*` |
| vLLM | 8000 | 推理服务，模型 `nvidia/Qwen3.6-35B-A3B-NVFP4`（上下文 131072） |

## 二、vLLM 推理服务配置

- 容器名：`vllm-server`，监听 `8000`，API 兼容 OpenAI 格式（`/v1`）。
- 模型：`nvidia/Qwen3.6-35B-A3B-NVFP4`，`max_model_len = 131072`。
- 引擎崩溃后需 `docker restart vllm-server`（本次故障根因之一：EngineCore 崩溃导致所有入库任务 RUNNING 卡死）。

验证：

```bash
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool
```

## 三、opencode-server 配置

### 1. 配置文件

`~/.config/opencode/opencode.jsonc`（opencode-server 运行用户的 home 下）。

#### 配置位置解析（部署时勿找错文件）

opencode 按以下顺序加载配置（见 `packages/opencode/src/config/config.ts`）：

1. **全局配置**（**权限/permission 配这里**）：`Global.Path.config` = XDG 配置目录 + `/opencode`，Linux 上即 `~/.config/opencode/`。同目录下按 `config.json` → `opencode.json` → `opencode.jsonc` 顺序加载，**后者的同名 key 覆盖前者**。
2. **项目级配置**（可选）：从工作目录向上查找 `opencode.jsonc` / `opencode.json`（如 `<cwd>/.opencode/opencode.jsonc`），通过 deep merge 叠加到全局之上 —— 项目级也可覆盖/增加 `permission`，但**未配置则不影响全局**。
3. **环境变量**：`OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` 可重定向配置来源（部署一般不用）。

> 日志中 `loading path=/home/bjglj/.opencode/opencode.jsonc` 只是工作目录向上查找的**尝试日志**；该文件不存在时读空返回 `{}`，不产生任何配置。真正生效的是 `~/.config/opencode/opencode.jsonc`。

验证当前生效位置与内容：

```bash
python3 -c "import json; d=json.load(open('/home/bjglj/.config/opencode/opencode.jsonc')); print(d.get('permission'))"
# 应输出: {'*': 'allow'}
```

### 2. provider 必须指向 vLLM

`provider.hsl` 的 `baseURL` 必须指向 vLLM 地址（不是 ollama/其他死端口）：

```jsonc
{
  "provider": {
    "hsl": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "hsl",
      "options": { "baseURL": "http://192.168.0.101:8000/v1" },
      "models": {
        "nvidia/Qwen3.6-35B-A3B-NVFP4": {
          "name": "Qwen3.6-35B-A3B-NVFP4",
          "limit": { "context": 131072, "output": 8000 },
          "options": { "max_tokens": 8000 }
        }
      }
    }
  }
}
```

> ⚠️ **模型 `limit` 必须配置**。`limit` 缺省时 opencode 会以 output=32000 请求，长文档（输入 99073 + 输出 32000 > 131072）会触发 vLLM 拒绝：`AI_APICallError: This model's maximum context length is 131072 tokens...`，导致 summary 失败。output 配 8000 即可避开。

### 3. permission 必须放行 headless 会话

**关键配置**（本次卡死根因）：headless wiki 会话（`wiki-session.ts` 的 `HEADLESS_RULESET` 只 deny question/plan，未覆盖 `external_directory`）在无头场景下触发权限询问会无人应答而**永久卡死**，并占用 wiki 并发信号量，后续任务全部排队 RUNNING。

```jsonc
{
  "permission": { "*": "allow" }
}
```

> ⚠️ 配置文件修改后必须**重启 opencode-server** 才生效（`systemctl restart opencode-server`）。全局配置有 TTL 缓存（`cachedInvalidateWithTTL`），不重启可能不生效。
>
> 生效验证：重启后日志中所有 `evaluated permission=...` 应为 `action.permission=* action.action=allow`（包括 `external_directory`、`edit`、`bash` 等），即无 `ask` 卡住。

### 4. 服务运行方式

- systemd 服务：`opencode-server.service`
- 二进制：`/home/bjglj/opencode-server`
- 日志：`~/.local/share/opencode/log/opencode.log`（UTC，本机时间 +8）
- systemctl 需 root：`echo '<sudo密码>' | sudo -S systemctl restart opencode-server`

## 四、业务系统（Java）配置

### 1. `sys_config` 表

| config_key | 值 | 说明 |
|---|---|---|
| `km.opencode-base-url` | `http://localhost:4096` | opencode 服务地址（Java 侧勿写 127.0.0.1 之外的地址） |
| `km.llm-root` | `/home/bjglj/llm-wiki-skill/aistore` | **服务端路径**。注意勿配成开发机 Windows 路径（如 `D:/hsl/...`），否则 wiki 会话落到错误目录 |

```sql
UPDATE sys_config SET config_value='/home/bjglj/llm-wiki-skill/aistore' WHERE config_key='km.llm-root';
```

### 2. `km_category.llm_path`（分类级知识库路径）

文档入库落点由 `KmLlmPathResolver` 决定，**分类级 `llm_path` 优先于 `km.llm-root`**：

- PUBLIC 文档 → 所属分类沿 parentId 上溯到根分类，取根分类的 `llm_path`；缺失/为空回退 `km.llm-root`。
- PRIVATE 文档 → `{km.llm-root}/my/{ownerId}/`。

**配置要求**：`llm_path` 必须指向一个**已初始化、可写**的 llm-wiki 知识库目录（含 `.wiki-schema.md`）。指向空目录会导致 wiki 会话写不出 source 页 → `summary=SKIPPED`（本次故障根因）。

> ⚠️ **`llm_path` 存绝对路径**（如 `/home/bjglj/llm-wiki-wyzl`），不要存相对路径。`KmLlmPathResolver.resolve` 与 `KmWorkspaceMergerImpl` 均按绝对路径原样返回，拼接 `km.llm-root` 前缀会导致路径错误。

```sql
-- 示例：把「网页资料」分类指向已初始化的 wiki 库
UPDATE km_category SET llm_path='/home/bjglj/llm-wiki-wyzl', update_time=NOW() WHERE id=2084950142946004994;
```

### 3. workspaceId 键空间（图谱隔离）

opencode 图谱按 `workspaceId` 隔离存储，**入库写入与查询必须使用同一键空间**（`KmLlmPathResolver.resolveWorkspaceId` 与 `KmWorkspaceMergerImpl` 共用定义）：

| 文档范围 | workspaceId |
|---|---|
| PUBLIC（公共） | `kb_km_{根分类Id}`（每个 PUBLIC 根目录一个工作区） |
| PRIVATE（个人） | `my_{ownerId}` |

- 入库通知（`KmIngestServiceImpl.notify`）与 `getKnowledge`（`KmWorkspaceMergerImpl.mergeKmWorkspaces`）都走此键空间，保证图谱写入/查询一致。
- 旧版固定 `kb_km` 单工作区的行为已废弃；若存在旧数据（图谱写在 `kb_km` 下），查询端 `kb_km_{rootId}` 将查不到，需重新入库。

## 五、llm-wiki 知识库目录要求

| 要求 | 说明 |
|---|---|
| 已初始化 | 目录内必须有 `.wiki-schema.md`、`raw/`、`wiki/`（用 `init-wiki.sh` 初始化过） |
| 可写 | 目录属主必须是 opencode-server 运行用户（如 `bjglj`）。root 拥有的空目录写不进 → SKIPPED |
| 命名 | source 页按「日期-标题」命名；业务端还会以 `{documentId}.md` 落盘供 `/serve/api/summary` 读取 |

## 六、入库状态流转与重触发

- 状态流转：`PENDING → RUNNING → SUCCESS/FAILED`，由 Java `KmIngestRetryTask`（每 30 分钟）与 `syncRunningStatus`（轮询 jobs）驱动。
- 手动重触发：模拟 Java 的 JWT + `POST /serve/api/ingest`（opencode 侧只解码 JWT payload 的 `userId/userName/tenantId`，不验签）：

```bash
# 构造 JWT（payload 需含 userId + userName）
TOKEN=$(python3 -c "import json,base64; h=base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}).encode()).rstrip(b'=').decode(); p=base64.urlsafe_b64encode(json.dumps({'loginType':'login','userId':1,'userName':'admin','tenantId':'000000'}).encode()).rstrip(b'=').decode(); print(f'{h}.{p}.fakesig')")

curl -s -X POST http://127.0.0.1:4096/serve/api/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Clientid: 1" -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "kb_km",
    "documents": [{
      "documentId": "2084952183953051649",
      "title": "文档标题",
      "categoryId": "cat_2084950142946004994",
      "llmPath": "/home/bjglj/llm-wiki-wyzl",
      "secretLevel": "PUBLIC",
      "format": "docx",
      "summary": null,
      "keywords": [],
      "operation": "CREATE",
      "fileContent": "<base64 内容>"
    }]
  }'
```

提交成功后把返回的 `jobId` 回写 `km_ingest_log.job_id` 并置 `ingest_status='RUNNING'`，Java 定时任务即会接管终态同步。

## 七、常见故障排查表

| 现象 | 根因 | 修复 |
|---|---|---|
| 任务长期 RUNNING，无 opencode 日志 | vLLM 引擎崩溃 | `docker restart vllm-server` |
| `Model not found` | provider `baseURL` 指向死端口/错误地址 | 改 `provider.hsl.options.baseURL` → vLLM `/v1` |
| 任务卡死、日志有 `permission=... ask` | headless 会话权限询问无人应答 | `opencode.jsonc` 配 `permission: {"*": "allow"}` 并重启 |
| `AI_APICallError: maximum context length is 131072` | 模型未配 `limit`，默认 output 32000 超限 | provider 模型配 `limit: {context:131072, output:8000}` |
| `wiki session finished but no source page written` | `llm_path` 指向空/未初始化/不可写目录 | 分类 `llm_path` 指向已初始化、`bjglj` 可写的 wiki 库 |
| 日志出现 `/home/bjglj/D:/hsl/...` | `km.llm-root` 误配成 Windows 路径 | `sys_config` 改为服务端路径 |
| `/api/model` 查不到 hsl 模型 | 配置未加载/服务未重启 | 修改配置后重启 opencode-server；catalog 加载需几秒 |
