# opencode-server 发布包 —— 现场部署操作手册（给 opencode 代理）

**版本**: 2026-08-11 发布
**代码**: dev 分支，commit `80129478cc`（含 OCR 兜底 + 可配置 wiki 模型 + bjj 供应商 + **知识库历史会话按用户隔离**）
**包**: `opencode-release.tar.gz`（61M）

> ⚠️ **必须用 `80129478cc` 之后的新包**：`47613a8225` 及更早的二进制**没有**会话按用户隔离功能，
> 会出现不同用户的历史会话串在一起（一个用户看到别人的问答记录）。请重新打包再部署。

---

## 一、包内容

| 路径（包内） | 内容 | 部署目标 |
|---|---|---|
| `bin/opencode-server` | 后端二进制（122M，已编译） | `/home/bjglj/opencode-server` |
| `spa/` | 前端 SPA（opencode web UI） | `/home/bjglj/nginx/html/opencode/` |
| `conf/opencode.jsonc` | opencode 配置（**bjj 供应商**） | `/home/bjglj/.config/opencode/opencode.jsonc` |
| `env/models-full.json` | 模型列表 | `/home/bjglj/.opencode/models-full.json` |
| `env/models.json` | 模型配置 | `/home/bjglj/.opencode/models.json` |
| `ppt-skill/` | PPT 生成技能 | `/home/bjglj/opencode-new/packages/opencode/src/knowledge/ppt-skill/` |
| `llm-wiki-skill/` | llm-wiki 技能（101 文件） | `/home/bjglj/.agents/skills/llm-wiki` + `/home/bjglj/.config/opencode/skills/llm-wiki` |
| `systemd/opencode-server.service` | systemd 服务单元（含 WIKI_LLM_PROVIDER=bjj） | `/etc/systemd/system/opencode-server.service` |

---

## 二、部署步骤（按顺序执行）

### 步骤 0：解压
```bash
mkdir -p /tmp/release && tar -xzf opencode-release.tar.gz -C /tmp/release
```

### 步骤 1：安装系统依赖
```bash
apt install -y ffmpeg libreoffice poppler-utils tesseract-ocr tesseract-ocr-chi-sim
```
> ⚠️ **OCR 必装**：`tesseract-ocr` + `tesseract-ocr-chi-sim`。知识入库遇到扫描件/旧格式文档时，
> 后端用 `tesseract -l chi_sim` 做 OCR 兜底。不装则这些文档入库会静默跳过（SKIPPED）。
> 已验证目标环境为 tesseract 5.3.4。

### 步骤 2：部署二进制与配置
```bash
# 二进制
install -m 755 /tmp/release/bin/opencode-server /home/bjglj/opencode-server

# opencode 配置（bjj 供应商）
mkdir -p /home/bjglj/.config/opencode
cp /tmp/release/conf/opencode.jsonc /home/bjglj/.config/opencode/opencode.jsonc

# 模型配置
mkdir -p /home/bjglj/.opencode
cp /tmp/release/env/models-full.json /tmp/release/env/models.json /home/bjglj/.opencode/

# 前端 SPA
mkdir -p /home/bjglj/nginx/html/opencode
cp -r /tmp/release/spa/. /home/bjglj/nginx/html/opencode/

# PPT 技能
mkdir -p /home/bjglj/opencode-new/packages/opencode/src/knowledge
cp -r /tmp/release/ppt-skill /home/bjglj/opencode-new/packages/opencode/src/knowledge/ppt-skill

# llm-wiki 技能（两个技能目录都要装）
mkdir -p /home/bjglj/.agents/skills /home/bjglj/.config/opencode/skills
cp -r /tmp/release/llm-wiki-skill /home/bjglj/.agents/skills/llm-wiki
cp -r /tmp/release/llm-wiki-skill /home/bjglj/.config/opencode/skills/llm-wiki
```

### 步骤 3：安装 systemd 服务
```bash
install -m 644 /tmp/release/systemd/opencode-server.service /etc/systemd/system/opencode-server.service
systemctl daemon-reload
systemctl enable --now opencode-server
```

### 步骤 4：nginx 前端（若新环境）
```bash
# nginx root 指向 /home/bjglj/nginx/html，访问 /opencode/ 路径
# 需配置 nginx server 块；若沿用现有 nginx 配置则跳过此步
```

---

## 三、配置说明

### 3.1 知识入库模型（可配置，无需改代码）
`conf/opencode.jsonc` 中 **bjj 供应商** 提供入库 LLM：
```jsonc
"provider": {
  "bjj": {
    "name": "bjj",
    "npm": "@ai-sdk/openai-compatible",
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
```
**知识入库会话使用的模型由环境变量控制**（systemd 单元里已配好默认值）：
| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WIKI_LLM_PROVIDER` | `bjj` | 入库会话的 provider ID |
| `WIKI_LLM_MODEL` | `nvidia/Qwen3.6-35B-A3B-NVFP4` | 入库会话的模型 ID |

如需切换模型，修改 `/etc/systemd/system/opencode-server.service` 里的
`Environment=WIKI_LLM_MODEL=...`，然后 `systemctl daemon-reload && systemctl restart opencode-server`。
> 改配置后**必须重启服务**才生效（配置为进程启动时加载）。

### 3.2 业务后端对接
`KNOWLEDGE_API_BASE_URL=http://localhost:8080/prod-api`（systemd 单元内）——业务知识库 API。
> 若业务系统部署在其他地址，改此处 Environment 后重启。

### 3.2.1 历史会话按用户隔离（会话串线修复）

前端历史会话列表走原生 `GET /session` 接口，**必须带业务系统 JWT**（`Authorization: Bearer <jwt>` 请求头，
iframe URL 的 `Authorization`/`auth_token` 参数会自动透传）。服务端按 JWT 里的 userId/tenantId 隔离会话：

- **列表**：`session.list` 在 SQL 层按 `externalUserId`/`externalTenantId` 过滤（LIMIT 之前），
  只返回当前用户的会话 + 无外部元数据的旧会话。
- **创建**：原生 `POST /session` 在已认证知识库用户下自动写入 `externalUserId`/`externalTenantId`
  metadata，新会话天然归属当前用户。

**部署前提**：必须使用 `80129478cc` 之后的二进制（`47613a8225` 及更早没有该功能，会话会串线）。
旧会话（发布前创建、无 metadata）对所有用户可见，属预期兼容行为。

### 3.3 OCR 兜底（doc-parser）
内置解析（txt/md/pdf文本层/docx）拿不到文本时自动调 tesseract OCR：
- 图片（png/jpg/bmp/tiff/webp）→ 直接 tesseract
- 扫描版 PDF → pdftoppm 渲染 → tesseract
- doc/xlsx/pptx → soffice 转 pdf → pdftoppm → tesseract
可配置环境变量：`TESSERACT_CMD`（默认 tesseract）、`OCR_SOFFICE_CMD`（默认 soffice）。
外部命令缺失/失败 → 静默返回空，不打断入库。

---

## 四、验证清单

```bash
# 1. 服务状态
systemctl is-active opencode-server        # 期望: active
systemctl status opencode-server           # 期望: Running

# 2. 端口与 API
ss -tlnp | grep 4096                       # 期望: LISTEN
curl http://localhost:4096/serve/api/workspaces   # 期望: {"data":[]}

# 3. OCR 可用性
tesseract --version                        # 期望: tesseract 5.3.4
tesseract --list-langs | grep chi_sim      # 期望: chi_sim

# 4. 配置生效（bjj 供应商）
grep '"bjj"' /home/bjglj/.config/opencode/opencode.jsonc   # 期望: "bjj": {

# 5. 入库模型环境变量
systemctl show opencode-server -p Environment | tr ' ' '\n' | grep WIKI_LLM
# 期望: WIKI_LLM_PROVIDER=bjj  WIKI_LLM_MODEL=nvidia/Qwen3.6-35B-A3B-NVFP4

# 5.1 历史会话按用户隔离
#   用两个不同用户的 JWT 分别请求，返回的会话列表应互不包含对方。
#   <jwt1>/<jwt2> 替换为两个不同业务用户的 JWT；<dir> 为知识库工作目录。
curl -H "Authorization: Bearer <jwt1>" "http://localhost:4096/session?directory=<dir>&limit=50&roots=true" | jq 'length'
curl -H "Authorization: Bearer <jwt2>" "http://localhost:4096/session?directory=<dir>&limit=50&roots=true" | jq 'length'

# 6. 前端
curl -s -o /dev/null -w "%{http_code}" http://<host>/opencode/   # 期望: 200
```

---

## 五、故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 入库 SKIPPED + 日志 "文档正文为空" | 文档是扫描件/旧格式且无 tesseract | 确认 `tesseract-ocr-chi-sim` 已装 |
| 入库会话报模型不存在 | WIKI_LLM_PROVIDER/MODEL 与配置不符 | 检查 systemd Environment + bjj 供应商模型定义 |
| 业务 API 404 | KNOWLEDGE_API_BASE_URL 指向错误 | 修改 Environment 后重启 |
| 前端 404 | SPA 未部署到 nginx html | 重新 `cp -r /tmp/release/spa/. <nginx html>/opencode/` |
| 历史会话串线（A 用户看到 B 用户的会话） | 二进制是 `47613a8225` 或更早（无按用户隔离） | 用 `80129478cc` 之后的新包重新部署并重启 |
| 改配置不生效 | 未重启服务 | 配置进程启动时加载，必须 `systemctl restart` |

---

## 六、知识库数据（可选迁移）
知识库内容目录 `/home/bjglj/llm-wiki-skill/aistore`（wiki/sources 等，含已补写的 documentId）
**不在本包内**。若需迁移历史知识库数据，请单独索要该目录的打包文件。
