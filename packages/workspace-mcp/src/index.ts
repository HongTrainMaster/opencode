import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v3"

const root = Bun.env.WORKSPACE_ROOT ?? process.cwd()
const server = new McpServer({
  name: "workspace-mcp-server",
  version: "0.0.0",
})

server.registerTool(
  "workspace_get_info",
  {
    title: "Get Workspace Information",
    description: "Returns the configured workspace root and whether it is a Git worktree.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const output = {
      root,
      is_git_worktree:
        (await Bun.spawn(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe" }).exited) === 0,
    }
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    }
  },
)

// @ts-expect-error TS2589
server.registerTool(
  "workspace_read_file",
  {
    title: "Read a Workspace File",
    description: "Reads UTF-8 text from one file inside the configured workspace. Paths outside the workspace are rejected.",
    inputSchema: {
      path: z.string().min(1).describe("Relative path to a UTF-8 text file within the workspace"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path }) => {
    const filePath = resolveWorkspacePath(path)
    const file = Bun.file(filePath)
    if (!(await file.exists())) throw new Error(`File not found: ${path}`)
    const output = {
      path,
      content: await file.text(),
    }
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    }
  },
)

function resolveWorkspacePath(input: string) {
  const candidate = `${root}/${input}`.replaceAll("\\", "/")
  const normalized = candidate.split("/").reduce<string[]>((parts, part) => {
    if (!part || part === ".") return parts
    if (part === "..") return parts.slice(0, -1)
    return [...parts, part]
  }, [])
  const resolved = normalized.join("/")
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "")
  if (resolved === normalizedRoot || !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error("The requested path must remain within the workspace")
  }
  return resolved
}

await server.connect(new StdioServerTransport())
