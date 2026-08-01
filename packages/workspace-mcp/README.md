# Workspace MCP Server

This local, read-only MCP server lets an MCP client inspect the current workspace.

It provides:

- `workspace_get_info`: the workspace root and Git-worktree status
- `workspace_read_file`: UTF-8 file contents for a relative path inside the workspace

Run it directly with:

```powershell
bun run ./packages/workspace-mcp/src/index.ts
```

The repository's `opencode.json` already registers it under the `workspace` MCP server name.
