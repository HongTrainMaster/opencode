# opencode-server 发布包 —— 现场部署操作手册（给 opencode 代理）

**版本**: 2026-08-12 发布
**代码**: dev 分支，commit `1fe3a5dec8`（OCR 兜底 + 可配置 wiki 模型 + bjj 供应商 + 知识库历史会话
按用户严格隔离 + JWT 签名校验 fail-closed + 19 位 user_id 精度修复 + 前端 Bearer 归一化 +
知识库首页历史会话列表）
**包**: `opencode-release.tar.gz`（61M）

> ⚠️ **必须用 `a292e1693c` 之后的新包**（`1fe3a5dec8` 已于 2026-08-12 部署并验证）。更早的二进制有不同问题：
> - `47613a8225` 及更早：**没有**会话按用户隔离功能，不同用户历史会话串在一起（一个用户看到别人的问答记录）。
> - `80129478cc`～`d6004d3765`：有隔离但无 `KNOWLEDGE_SESSION_ISOLATION` 显式开关、无 JWT 签名校验（未验签可伪造身份）。
> - `4ae34c7a51` 之前：JWT fail-closed 但无 loginId 精度修复（19 位 user_id 被 JS `JSON.parse` 四舍五入，隔离对不上，见 §3.2.1）。
> - `61d70e4cd3` 之后：前端增加知识库 JWT 跨路由持久化 + **Bearer 双重前缀归一化**（业务系统 URL 传的
>   Authorization 已带 "Bearer " 前缀，SDK 不再拼出 "Bearer Bearer ..."），并修复了知识库首页
>   历史会话列表（右侧面板）与滚动条布局。

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
> ⚠️ **systemd 单元内必须包含**：`KNOWLEDGE_SESSION_ISOLATION=true`、`KNOWLEDGE_JWT_SECRET=<sa-token
> jwt-secret-key>`（取业务系统 `application.yml` 的 `sa-token.jwt-secret-key`）、`WIKI_LLM_PROVIDER`/`WIKI_LLM_MODEL`。
> 缺失 `KNOWLEDGE_JWT_SECRET` 会导致所有 JWT fail-closed、会话列表为空（详见 §3.2.1 / §五 故障排查）。

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
iframe URL 的 `Authorization`/`auth_token` 参数会自动透传）。服务端按 JWT 里的 userId/tenantId 隔离会话。

**⚠️ 必须同时配置以下两个 Environment（否则隔离不生效 或 身份校验失败）：**

| 环境变量 | 值 | 说明 |
|---|---|---|
| `KNOWLEDGE_SESSION_ISOLATION` | `true` | **会话隔离总开关**，知识库部署必须显式开启 |
| `KNOWLEDGE_JWT_SECRET` | 业务系统 sa-token 的 `jwt-secret-key`（如 `abcdefghijklmnopqrstuvwxyz`） | JWT **签名校验密钥**（HS256） |

> ⚠️ **签名校验是安全底线**：服务端对每个 JWT 做 HS256 签名 + `exp` 过期校验，**不再信任未验签的
> claims**。未配置 `KNOWLEDGE_JWT_SECRET` 时所有 JWT 认证会 fail-closed（身份为空 → 会话列表返回空），
> 而不是放行。若 `KNOWLEDGE_API_BASE_URL` 已设置但未开隔离，服务启动日志会输出醒目 WARN 提醒。

> ⚠️ **user_id 精度**：业务系统 `sys_user.id` 是 19 位雪花 ID（> 2^53），JWT payload 里以 JSON number
> 表示会被 JS `JSON.parse` 四舍五入（如 `1966044826377150466` → `1966044826377150500`）。服务端**优先从
> sa-token 的 `loginId` claim**（`"sys_user:1966044826377150466"`，字符串，无精度损失）提取精确 userId，
> 仅当无 `loginId` 时回退 `payload.userId`。因此必须用 `a292e1693c` 之后的二进制，19 位用户的会话隔离才正确。

**隔离语义：**

- **列表**：`session.list` 在 SQL 层按 `externalUserId`/`externalTenantId` 严格过滤（LIMIT 之前），
  只返回当前用户创建的会话。**无外部元数据的旧会话/系统内部会话（wiki/ppt/ingest）不返回**。
- **创建**：原生 `POST /session` 在已认证知识库用户下自动写入 `externalUserId`/`externalTenantId`
  metadata，新会话天然归属当前用户；匿名创建被拒绝（401）。
- **会话级访问**：`get/messages/fork/update/remove/prompt/command/shell/share/unshare/summarize` 等
  所有按会话 ID 的接口都校验属主——匿名或非属主一律 401，用户无法凭 ID 读取/篡改他人会话。
- **其他入口**：`/experimental/session`（listGlobal）、`/serve/api/knowledge/session/list` 同样按用户过滤。

**会话归属 = 创建时登录的账号**：会话的 `externalUserId` 由创建时 JWT 解析出的身份写入。若同一批会话在
不同账号（如 `admin` 与 `bjjadmin`）之间建过，则旧账号建的会话对新账号**不可见**（打开时属主校验 401）——
这是隔离的预期行为，不是 bug。解决：用属主账号登录，或将会话归属迁移到当前账号（见 §六 数据迁移）。

**部署前提**：必须使用 `a292e1693c` 之后的二进制（更早版本的问题见文首版本说明）。

### 3.2.2 前端 JWT 传递（Bearer 归一化 + 跨路由持久化）

知识库 iframe 打开 opencode 前端时，业务系统把 JWT 放在 URL 参数（`Authorization` 或 `auth_token`，
可能已带 `Bearer ` 前缀）。前端 SDK（`createSdkForServer`/`createApiForServer`）会把该值附加为
`Authorization: Bearer <jwt>` 请求头。**若 URL 值已带 "Bearer " 前缀，会归一化去重**，避免发送
`Bearer Bearer ...` 导致 401。同时 JWT 在应用启动时持久化到 `sessionStorage`（`opencode_knowledge_token`），
保证从知识库首页进入会话页等跨路由请求都携带身份。

> 若出现「前端已发送单个 Bearer 但仍 401」，多半是浏览器缓存了旧版 JS，硬刷新（Ctrl+Shift+R）即可。

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

# 5.1 会话隔离环境变量（必须都在）
systemctl show opencode-server -p Environment | tr ' ' '\n' | grep -E 'KNOWLEDGE_SESSION_ISOLATION|KNOWLEDGE_JWT_SECRET'
# 期望: KNOWLEDGE_SESSION_ISOLATION=true 和 KNOWLEDGE_JWT_SECRET=<jwt-secret-key>

# 5.2 历史会话按用户隔离
#   用两个不同用户的 JWT 分别请求，返回的会话列表应互不包含对方。
#   <jwt1>/<jwt2> 替换为两个不同业务用户的 JWT；<dir> 为知识库工作目录。
curl -H "Authorization: Bearer <jwt1>" "http://localhost:4096/session?directory=<dir>&limit=50&roots=true" | jq 'length'
curl -H "Authorization: Bearer <jwt2>" "http://localhost:4096/session?directory=<dir>&limit=50&roots=true" | jq 'length'

# 5.3 匿名请求看不到任何会话（隔离必须 deny-by-default）
curl "http://localhost:4096/session?directory=<dir>&limit=50&roots=true" | jq 'length'   # 期望: 0

# 5.4 会话级属主校验 + 19 位 user_id 精度
#   <owner-jwt> = 属主账号 JWT（含精确 loginId）；<other-jwt> = 另一账号 JWT；<sessionID> = 属主建的会话
curl -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <owner-jwt>" "http://localhost:4096/session/<sessionID>"   # 期望: 200
curl -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <other-jwt>" "http://localhost:4096/session/<sessionID>"   # 期望: 401
#   若属主是 19 位用户，服务端日志应看到精确 id（...466）而非四舍五入（...500）：
journalctl -u opencode-server --since '1 min ago' | grep 'JWT verified userId='   # 期望: 精确 id

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
| 历史会话串线（A 用户看到 B 用户的会话） | 二进制是 `47613a8225` 或更早（无按用户隔离） | 用 `a292e1693c` 之后的新包重新部署并重启 |
| 会话列表为空/历史不见了 | 隔离已开启但未配置 `KNOWLEDGE_JWT_SECRET`，JWT 校验 fail-closed（身份为空） | 配置 `KNOWLEDGE_JWT_SECRET=<jwt-secret-key>` 后重启 |
| 匿名/不带 token 能看全部会话 | 未开启隔离（缺 `KNOWLEDGE_SESSION_ISOLATION=true`），启动日志有 WARN | 补配 `KNOWLEDGE_SESSION_ISOLATION=true` 后重启 |
| 打开历史会话报 401（前端 GET /session/{id} → 401） | 会话归属账号 ≠ 当前登录账号（属主校验隔离，见 §3.2.1） | 用属主账号登录；或将会话 `externalUserId` 迁移到当前账号（见 §6.1） |
| 身份解析成错误 userId（日志 `...500` 而非 `...466`） | 二进制无 loginId 精度修复（< `a292e1693c`） | 用 `a292e1693c` 之后的新包重新部署并重启 |
| 改配置不生效 | 未重启服务 | 配置进程启动时加载，必须 `systemctl restart` |

---

## 六、知识库数据（可选迁移）
知识库内容目录 `/home/bjglj/llm-wiki-skill/aistore`（wiki/sources 等，含已补写的 documentId）
**不在本包内**。若需迁移历史知识库数据，请单独索要该目录的打包文件。

### 6.1 会话归属迁移（跨账号会话不可见时）
会话归属存在 SQLite `~/.local/share/opencode/opencode-local.db` 的 `session.metadata`（JSON）的
`externalUserId`/`externalNickName` 字段。当同一批会话需要从旧账号迁移到当前账号时：

```python
import sqlite3, json, time
DB = '/home/bjglj/.local/share/opencode/opencode-local.db'
src = sqlite3.connect(DB)
# 1) 先做一致性备份
dst = sqlite3.connect(f'/home/bjglj/backups/opencode-local-{int(time.time())}.db')
src.backup(dst); dst.close()
NEW_ID, NEW_NAME = "1966044826377150466", "bjjadmin"   # 当前账号
n = 0
for sid, d, meta in src.execute("SELECT id, directory, metadata FROM session").fetchall():
    if 'llm-wiki' not in (d or ''):            # 只迁移知识库目录
        continue
    m = json.loads(meta)
    if m.get('externalUserId') == '1':         # 旧账号
        m['externalUserId'] = NEW_ID
        m['externalNickName'] = NEW_NAME
        src.execute("UPDATE session SET metadata=? WHERE id=?", (json.dumps(m, ensure_ascii=False), sid))
        n += 1
src.commit(); print('migrated', n)
```
- SQLite 实时读取，迁移后**无需重启**，前端刷新页面即生效。
- 迁移后旧账号对这些会话不可见（属主校验 401），符合隔离预期。
- 已于 2026-08-12 用此法把知识库目录 152 条会话从 `externalUserId="1"`（admin）迁移到
  `1966044826377150466`（bjjadmin），备份 `/home/bjglj/backups/opencode-local-1786493237.db`。
