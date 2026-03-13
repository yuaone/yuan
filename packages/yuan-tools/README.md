# @yuaone/tools

Tool implementations for YUAN coding agent.

```bash
npm install @yuaone/tools
```

## Available Tools

| Tool | Description |
|------|-------------|
| `file_read` | Read file contents |
| `file_write` | Write or create a file |
| `file_edit` | Surgical string replacement in a file |
| `shell_exec` | Execute shell commands |
| `grep` | Search file contents with regex |
| `glob` | Find files by pattern |
| `git_ops` | Git status/diff/log/commit |
| `web_search` | Search the web |
| `web_fetch` | Fetch a URL |
| `code_search` | Semantic code search |

## Usage

```typescript
import { ToolRegistry } from "@yuaone/tools";

const registry = new ToolRegistry({ workDir: process.cwd() });
const result = await registry.execute("file_read", { path: "src/index.ts" });
```

## License

AGPL-3.0 — part of [YUAN](https://github.com/yuaone/yuan).
