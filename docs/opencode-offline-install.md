# opencode 生产环境离线安装包 —— 现场部署操作手册

**版本**: 2026-09-01 发布
**包**: `opencode-release-full-2026-09-01.tar.gz`（468M）

> 本包适用于**客户现场无外网**的环境。所有运行依赖已内置，无需联网。

---

## 一、包内容

| 路径（包内） | 内容 | 说明 |
|---|---|---|
| `bin/opencode` | opencode TUI 官方二进制 v1.18.25（177M） | 交互式终端 UI |
| `bin/opencode-server` | 后端服务二进制（122M，含入库/知识库路由） | 知识库 API（端口 4096） |
| `bin/opencode-linux-x64.tar.gz` | 官方原始发布包（备用） | |
| `spa/` | 前端 SPA（opencode web UI，1651 文件） | nginx `/opencode/` |
| `conf/opencode.jsonc` | opencode 配置（**bjj 供应商 = 移动云 DeepSeek**） | |
| `env/` | models-full.json + models.json 模型列表 | |
| `systemd/opencode-server.service` | systemd 服务单元（WIKI_LLM_PROVIDER=bjj） | |
| `ppt-skill/` | PPT 生成技能 | |
| `llm-wiki-skill/` | llm-wiki 技能（78 文件） | |
| `deps/apt/*.deb` | 系统依赖离线包（443 个，295M） | tesseract/ffmpeg/libreoffice/poppler |

---

## 二、部署步骤（按顺序执行）

### 步骤 0：解压
```bash
mkdir -p /tmp/release && tar -xzf opencode-release-full-2026-09-01.tar.gz -C /tmp/release
```

### 步骤 1：安装系统依赖（离线）
```bash
# 已确认目标系统为 Ubuntu 24.04 x86_64
sudo dpkg -i /tmp/release/deps/apt/*.deb
# 若报依赖缺失（极小概率），执行修复：
sudo apt-get -f install -y
```
> 包含：tesseract-ocr + chi_sim/eng 语言包、ffmpeg、LibreOffice、poppler-utils。
> OCR 兜底、doc/xlsx 转 PDF、媒体处理均依赖这些。

### 步骤 2：安装二进制
```bash
# 后端服务（4096）
sudo install -m 755 /tmp/release/bin/opencode-server /home/bjglj/opencode-server

# TUI 官方版（全局命令）
sudo install -m 755 /tmp/release/bin/opencode /usr/local/bin/opencode
```

### 步骤 3：部署配置与前端
```bash
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

# llm-wiki 技能
mkdir -p /home/bjglj/.agents/skills /home/bjglj/.config/opencode/skills
cp -r /tmp/release/llm-wiki-skill /home/bjglj/.agents/skills/llm-wiki
cp -r /tmp/release/llm-wiki-skill /home/bjglj/.config/opencode/skills/llm-wiki
```

### 步骤 4：安装 systemd 服务
```bash
sudo install -m 644 /tmp/release/systemd/opencode-server.service /etc/systemd/system/opencode-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-server
```
> ⚠️ 单元内需包含：`KNOWLEDGE_SESSION_ISOLATION=true`、`KNOWLEDGE_JWT_SECRET=<sa-token jwt-secret-key>`、
> `WIKI_LLM_PROVIDER=bjj`、`WIKI_LLM_MODEL=deepseek-v4-flash`。若现场业务系统不同，改后重启。

### 步骤 5：nginx（若新环境）
```bash
# nginx root 指向 /home/bjglj/nginx/html，访问 /opencode/ 路径
# 需配置 /serve/api 代理到 127.0.0.1:4096（见参考 nginx.conf）
```

---

## 三、验证清单

```bash
# 1. 后端服务
systemctl is-active opencode-server            # active
curl http://localhost:4096/serve/api/workspaces  # {"data":[]}

# 2. 入库路由（关键！缺此路由会入库失败）
curl -s -X POST http://localhost:4096/serve/api/ingest -H 'Content-Type: application/json' -d '{}' -w '%{http_code} %{content_type}'
# 期望: 400 application/json（路由存在，参数校验错误）；若返回 200 text/html 则路由缺失

# 3. TUI
opencode --version                              # 1.18.25
tmux new-session -d -s oc 'opencode' && tmux attach -t oc   # 应显示 OpenCode 界面

# 4. OCR
tesseract --version | head -1                   # tesseract 5.3.4
tesseract --list-langs | grep chi_sim            # chi_sim

# 5. 前端
curl -s -o /dev/null -w "%{http_code}" http://<host>/opencode/   # 200
```

---

## 四、配置说明

- **bjj 供应商** = 移动云 DeepSeek（`https://zhenze-huhehaote.cmecloud.cn/v1`，客户环境已配好 apiKey）。
- **入库模型**由 `WIKI_LLM_PROVIDER=bjj` + `WIKI_LLM_MODEL=deepseek-v4-flash` 控制（systemd 环境变量）。
- **会话隔离**：`KNOWLEDGE_SESSION_ISOLATION=true` + `KNOWLEDGE_JWT_SECRET`（业务系统 sa-token jwt-secret-key），
  缺失 JWT secret 会导致会话列表为空（fail-closed）。
- 详细说明见 `docs/opencode-release-DEPLOY.md`（仓库内）。
