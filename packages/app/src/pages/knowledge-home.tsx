import { base64Encode } from "@opencode-ai/core/util/encode"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useTabs } from "@/context/tabs"
import { useServer } from "@/context/server"

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
  // Auth token from URL query param (passed by the embedding app via iframe)
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
    const wsList = workspaces()
    const ws = wsList?.find((w: any) => w.workspaceId === workspaceId)
    if (ws) handleCreateDraft(ws)
  }

  return (
    <div class="knowledge-home">
      <style>{`
        .knowledge-home { display: flex; height: 100vh; font-family: system-ui, sans-serif; }
        .knowledge-sidebar { width: 260px; background: #f5f5f5; border-right: 1px solid #e0e0e0; padding: 16px; overflow-y: auto; }
        .knowledge-sidebar h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; color: #333; }
        .knowledge-workspace { display: block; width: 100%; text-align: left; padding: 10px 12px; margin-bottom: 4px; border: none; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; transition: background 0.15s; }
        .knowledge-workspace:hover { background: #e8e8e8; }
        .knowledge-workspace.active { background: #d0d0ff; font-weight: 500; }
        .knowledge-workspace:disabled { opacity: 0.6; cursor: default; }
        .knowledge-main { flex: 1; padding: 24px; overflow-y: auto; display: flex; align-items: center; justify-content: center; }
        .knowledge-empty { color: #888; font-size: 14px; padding: 24px; text-align: center; }
        .knowledge-start-btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 32px; background: #4a6cf7; color: #fff; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; transition: background 0.15s; }
        .knowledge-start-btn:hover { background: #3b5de7; }
        .knowledge-start-btn:disabled { opacity: 0.5; cursor: default; }
      `}</style>

      <nav class="knowledge-sidebar">
        <h2>知识库</h2>
        <For each={workspaces()}>
          {(ws: any) => (
            <button
              classList={{ "knowledge-workspace": true, active: selectedWorkspace() === ws.workspaceId }}
              onClick={() => handleSelectWorkspace(ws.workspaceId)}
              disabled={selectedWorkspace() === ws.workspaceId}
            >
              {ws.workspaceName}
            </button>
          )}
        </For>
      </nav>

      <main class="knowledge-main">
        <Show when={!selectedWorkspace()}>
            <div style="text-align:center;display:flex;flex-direction:column;align-items:center">
            <div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#333">开始新知识问答</div>
            <button class="knowledge-start-btn" onClick={handleNewSession} disabled={workspaces.loading}>
              {workspaces.loading ? "加载中..." : "新建会话 +"}
            </button>
            <div style="margin-top:16px;font-size:13px;color:#999">或从左侧选择一个知识库</div>
          </div>
        </Show>
        <Show when={selectedWorkspace()}>
          <div class="knowledge-empty">正在进入知识库...</div>
        </Show>
      </main>
    </div>
  )
}
