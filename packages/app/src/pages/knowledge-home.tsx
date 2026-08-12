import { base64Encode } from "@opencode-ai/core/util/encode"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useTabs } from "@/context/tabs"
import { useServer } from "@/context/server"

type KnowledgeWorkspace = {
  workspaceId: string
  workspaceName: string
  workspaceType?: string
  llmPath?: string
  directory?: string
}

type KnowledgeSession = {
  id: string
  title?: string
  time?: { updated?: number }
}

export function KnowledgeHome() {
  const [selectedWorkspace, setSelectedWorkspace] = createSignal<string | null>(null)
  const navigate = useNavigate()
  const tabs = useTabs()
  const server = useServer()
  // Persist roles from URL params to sessionStorage for use across routes
  createEffect(() => {
    const params = new URLSearchParams(location.search)
    const rolesParam = params.get("roles")
    if (rolesParam) {
      sessionStorage.setItem("opencode_roles", rolesParam)
    }
  })
  // Auth token from URL query param (passed by the embedding app via iframe).
  // Note: token is also persisted globally in entry.tsx (opencode_knowledge_token)
  // for cross-route SDK requests; authToken() here still prefers the live URL.
  const authToken = () => {
    const injected = (window as any).__INITIAL_AUTH_TOKEN__
    if (injected) return encodeURIComponent(injected)
    const params = new URLSearchParams(location.search)
    const authParam = params.get("Authorization") ?? params.get("auth_token")
    return authParam ? encodeURIComponent(authParam) : ""
  }
  const apiBase = () => "/serve/api"

  // Fetch workspaces from the API
  const [workspaces] = createResource(async () => {
    const tok = authToken()
    const url = tok ? `${apiBase()}/workspaces?Authorization=${tok}` : `${apiBase()}/workspaces`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return data.data ?? []
  })

  // Directory comes from the workspace entry returned by the API; no hard-coded
  // default so the page stays environment-agnostic.
  const dirOf = (workspace: any) => workspace?.llmPath || workspace?.directory || ""

  // 当前生效的 workspace：用户选择优先，未选择时默认第一个
  const activeWorkspace = () => {
    const wsList = workspaces()
    if (!wsList || wsList.length === 0) return undefined
    return wsList.find((w: any) => w.workspaceId === selectedWorkspace()) ?? wsList[0]
  }

  // 当前 workspace 的历史会话列表（走 knowledge.session.list，按用户隔离）
  const [sessions] = createResource(activeWorkspace, async (ws: KnowledgeWorkspace) => {
    const tok = authToken()
    const url = tok
      ? `${apiBase()}/sessions?workspaceId=${encodeURIComponent(ws.workspaceId)}&limit=50&Authorization=${tok}`
      : `${apiBase()}/sessions?workspaceId=${encodeURIComponent(ws.workspaceId)}&limit=50`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return (data.data ?? []) as KnowledgeSession[]
  })

  // Create a draft tab (new-session dialog) for the given workspace.
  // Falls back to direct API session creation if the tab system is unavailable.
  const handleCreateDraft = async (workspace: any) => {
    const directory = dirOf(workspace)
    if (server.key && tabs.ready()) {
      tabs.newDraft({ server: server.key, directory })
      return
    }

    // Fallback: create session directly via API (iframe / standalone mode)
    const tok = authToken()
    if (!tok) return
    try {
      const res = await fetch(`${apiBase()}/sessions?Authorization=${tok}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.workspaceId }),
      })
      if (!res.ok) return
      const data = await res.json()
      if (data?.data?.id) {
        const params = `Authorization=${tok}`
        navigate(`/${base64Encode(directory)}/session/${data.data.id}?${params}`, { replace: true })
      }
    } catch {}
  }

  // Create a session with the first workspace (quick start)
  const handleNewSession = () => {
    const wsList = workspaces()
    if (!wsList || wsList.length === 0) return
    handleCreateDraft(wsList[0])
  }
  const handleSelectWorkspace = (workspaceId: string) => {
    setSelectedWorkspace(workspaceId)
  }

  // Open an existing session by navigating to its page (iframe / standalone mode)
  const openSession = (session: KnowledgeSession) => {
    const ws = activeWorkspace()
    if (!ws) return
    const directory = dirOf(ws)
    const tok = authToken()
    const params = tok ? `?Authorization=${tok}` : ""
    navigate(`/${base64Encode(directory)}/session/${session.id}${params}`, { replace: true })
  }

  const formatTime = (ts?: number) => {
    if (!ts) return ""
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <div class="knowledge-home">
      <style>{`
        .knowledge-home { display: flex; height: 100vh; font-family: system-ui, sans-serif; }
        .knowledge-sidebar { width: 200px; background: #f5f5f5; border-right: 1px solid #e0e0e0; padding: 16px; overflow-y: auto; flex-shrink: 0; }
        .knowledge-sidebar h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #333; }
        .knowledge-workspace { display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 4px; border: none; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; transition: background 0.15s; }
        .knowledge-workspace:hover { background: #e8e8e8; }
        .knowledge-workspace.active { background: #d0d0ff; font-weight: 500; }
        .knowledge-workspace:disabled { opacity: 0.6; cursor: default; }
        .knowledge-main { flex: 1; min-width: 0; padding: 24px; overflow-y: auto; display: flex; align-items: flex-start; justify-content: center; }
        .knowledge-empty { color: #888; font-size: 14px; padding: 24px; text-align: center; }
        .knowledge-start-btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 32px; background: #4a6cf7; color: #fff; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; transition: background 0.15s; }
        .knowledge-start-btn:hover { background: #3b5de7; }
        .knowledge-start-btn:disabled { opacity: 0.5; cursor: default; }
        .knowledge-history { width: 280px; border-left: 1px solid #e0e0e0; background: #fafafa; display: flex; flex-direction: column; flex-shrink: 0; }
        .knowledge-history h2 { font-size: 14px; font-weight: 600; margin: 0; padding: 16px 16px 8px; color: #333; }
        .knowledge-history-list { flex: 1; overflow-y: auto; padding: 4px 8px 16px; }
        .knowledge-history-item { display: block; width: 100%; text-align: left; padding: 10px 12px; border: none; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; margin-bottom: 2px; transition: background 0.15s; }
        .knowledge-history-item:hover { background: #ececff; }
        .knowledge-history-title { color: #333; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .knowledge-history-time { color: #999; font-size: 11px; margin-top: 2px; }
        .knowledge-history-empty { color: #999; font-size: 13px; padding: 12px; text-align: center; }
        .knowledge-history-loading { color: #999; font-size: 13px; padding: 12px; text-align: center; }
      `}</style>

      <nav class="knowledge-sidebar">
        <h2>知识库</h2>
        <For each={workspaces()}>
          {(ws: any) => (
            <button
              classList={{ "knowledge-workspace": true, active: selectedWorkspace() === ws.workspaceId }}
              onClick={() => handleSelectWorkspace(ws.workspaceId)}
            >
              {ws.workspaceName}
            </button>
          )}
        </For>
      </nav>

      <main class="knowledge-main">
        <div style="text-align:center;display:flex;flex-direction:column;align-items:center;margin-top:10vh">
          <div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#333">开始新知识问答</div>
          <button class="knowledge-start-btn" onClick={handleNewSession} disabled={workspaces.loading}>
            {workspaces.loading ? "加载中..." : "新建会话 +"}
          </button>
          <div style="margin-top:16px;font-size:13px;color:#999">或从左侧选择一个知识库</div>
        </div>
      </main>

      <aside class="knowledge-history">
        <h2>历史会话</h2>
        <div class="knowledge-history-list">
          <Show when={!sessions.loading} fallback={<div class="knowledge-history-loading">加载中...</div>}>
            <Show when={(sessions() ?? []).length > 0} fallback={<div class="knowledge-history-empty">暂无历史会话</div>}>
              <For each={sessions()}>
                {(session) => (
                  <button class="knowledge-history-item" onClick={() => openSession(session)}>
                    <div class="knowledge-history-title">
                      {session.title || "(未命名会话)"}
                    </div>
                    <div class="knowledge-history-time">{formatTime(session.time?.updated)}</div>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </aside>
    </div>
  )
}
