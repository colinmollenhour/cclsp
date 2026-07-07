[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/ktnyt-cclsp-badge.png)](https://mseep.ai/app/ktnyt-cclsp)

# cclsp - not your average LSP adapter

[![npm version](https://badge.fury.io/js/cclsp.svg)](https://www.npmjs.com/package/cclsp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/cclsp.svg)](https://nodejs.org)
[![CI](https://github.com/ktnyt/cclsp/actions/workflows/ci.yml/badge.svg)](https://github.com/ktnyt/cclsp/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/cclsp.svg)](https://www.npmjs.com/package/cclsp)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**cclsp** is a Model Context Protocol (MCP) server that seamlessly integrates LLM-based coding agents with Language Server Protocol (LSP) servers. LLM-based coding agents often struggle with providing accurate line/column numbers, which makes naive attempts to integrate with LSP servers fragile and frustrating. cclsp solves this by intelligently trying multiple position combinations and providing robust symbol resolution that just works, no matter how your AI assistant counts lines.

## Setup & Usage Demo

https://github.com/user-attachments/assets/52980f32-64d6-4b78-9cbf-18d6ae120cdd

## Table of Contents

- [Why cclsp?](#why-cclsp)
- [Features](#features)
- [📋 Prerequisites](#-prerequisites)
- [⚡ Setup](#-setup)
  - [Automated Setup (Recommended)](#automated-setup-recommended)
  - [Claude Code Quick Setup](#claude-code-quick-setup)
  - [Manual Setup](#manual-setup)
  - [Language Server Installation](#language-server-installation)
  - [Verification](#verification)
- [🚀 Usage](#-usage)
  - [As MCP Server](#as-mcp-server)
  - [Configuration](#configuration)
- [🛠️ Development](#️-development)
- [🔧 MCP Tools](#-mcp-tools)
  - [`find_definition`](#find_definition)
  - [`find_references`](#find_references)
  - [`find_implementation`](#find_implementation)
  - [`rename_symbol`](#rename_symbol)
  - [`rename_symbol_strict`](#rename_symbol_strict)
  - [`get_diagnostics`](#get_diagnostics)
  - [`get_workspace_diagnostics`](#get_workspace_diagnostics)
  - [`get_hover`](#get_hover)
  - [`find_workspace_symbols`](#find_workspace_symbols)
  - [`prepare_call_hierarchy`](#prepare_call_hierarchy)
  - [`get_incoming_calls`](#get_incoming_calls)
  - [`get_outgoing_calls`](#get_outgoing_calls)
  - [`restart_server`](#restart_server)
- [💡 Real-world Examples](#-real-world-examples)
  - [Finding Function Definitions](#finding-function-definitions)
  - [Finding All References](#finding-all-references)
  - [Renaming Symbols](#renaming-symbols)
- [🔍 Troubleshooting](#-troubleshooting)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

## Why cclsp?

When using AI-powered coding assistants like Claude, you often need to navigate codebases to understand symbol relationships. **cclsp** bridges the gap between Language Server Protocol capabilities and Model Context Protocol, enabling:

- 🔍 **Instant symbol navigation** - Jump to definitions without manually searching
- 📚 **Complete reference finding** - Find all usages of functions, variables, and types
- ✏️ **Safe symbol renaming** - Rename across entire codebases with confidence
- 🌍 **Universal language support** - Works with any LSP-compatible language server
- 🤖 **AI-friendly interface** - Designed for LLMs to understand and use effectively

## Features

- **Go to Definition**: Find where symbols are defined
- **Find References**: Locate all references to a symbol
- **Multi-language Support**: Configurable LSP servers for different file types
- **TypeScript**: Built-in support via typescript-language-server
- **Python**: Support via python-lsp-server (pylsp)
- **Go**: Support via gopls
- **And many more**: Extensive language server configurations

## 📋 Prerequisites

- Node.js 18+ or Bun runtime
- Language servers for your target languages (installed separately)

## ⚡ Setup

cclsp provides an interactive setup wizard that automates the entire configuration process. Choose your preferred method:

### Automated Setup (Recommended)

Run the interactive setup wizard:

```bash
# One-time setup (no installation required)
npx cclsp@latest setup

# For user-wide configuration
npx cclsp@latest setup --user
```

The setup wizard will:

1. **🔍 Auto-detect languages** in your project by scanning files
2. **📋 Show pre-selected LSP servers** based on detected languages
3. **📦 Display installation requirements** with detailed guides
4. **⚡ Install LSPs automatically** (optional, with user confirmation)
5. **🔗 Add to Claude MCP** (optional, with user confirmation)
6. **✅ Verify setup** and show available tools

#### Setup Options

- **Project Configuration** (default): Creates `.claude/cclsp.json` in current directory
- **User Configuration** (`--user`): Creates global config in `~/.config/claude/cclsp.json`

### Manual Setup

If you prefer manual configuration:

1. **Install cclsp**:

   ```bash
   npm install -g cclsp
   ```

2. **Install language servers** (see [Language Server Installation](#language-server-installation))

3. **Create configuration file**:

   ```bash
   # Use the interactive generator
   cclsp setup

   # Or create manually (see Configuration section)
   ```

4. **Add to Claude MCP**:
   ```bash
   claude mcp add cclsp npx cclsp@latest --env CCLSP_CONFIG_PATH=/path/to/cclsp.json
   ```

### Language Server Installation

The setup wizard shows installation commands for each LSP, but you can also install them manually:

<details>
<summary>📦 Common Language Servers</summary>

#### TypeScript/JavaScript

```bash
npm install -g typescript-language-server typescript
```

#### Python

```bash
pip install "python-lsp-server[all]"
# Or basic installation: pip install python-lsp-server
```

#### Go

```bash
go install golang.org/x/tools/gopls@latest
```

#### Rust

```bash
rustup component add rust-analyzer
rustup component add rust-src
```

#### C/C++

```bash
# Ubuntu/Debian
sudo apt install clangd

# macOS
brew install llvm

# Windows: Download from LLVM releases
```

#### Ruby

```bash
gem install solargraph
```

#### PHP

```bash
npm install -g intelephense
```

For more languages and detailed instructions, run `npx cclsp@latest setup` and select "Show detailed installation guides".

</details>

## 🚀 Usage

### As MCP Server

Configure in your MCP client (e.g., Claude Code):

#### Using npm package (after global install)

```json
{
  "mcpServers": {
    "cclsp": {
      "command": "cclsp",
      "env": {
        "CCLSP_CONFIG_PATH": "/path/to/your/cclsp.json"
      }
    }
  }
}
```

#### Using local installation

```json
{
  "mcpServers": {
    "cclsp": {
      "command": "node",
      "args": ["/path/to/cclsp/dist/index.js"],
      "env": {
        "CCLSP_CONFIG_PATH": "/path/to/your/cclsp.json"
      }
    }
  }
}
```

#### Disabling cclsp tools

You can hide and disable specific MCP tools directly in `cclsp.json` with the top-level `tools` field. Tools not listed default to enabled; set a tool to `false` to disable it.

For example, to disable refactoring, hover, and call-hierarchy tools while keeping `find_*`, diagnostics, and server restart tools available:

```json
{
  "tools": {
    "rename_symbol": false,
    "rename_symbol_strict": false,
    "get_hover": false,
    "prepare_call_hierarchy": false,
    "get_incoming_calls": false,
    "get_outgoing_calls": false
  },
  "servers": [
    {
      "extensions": ["ts", "tsx", "js", "jsx"],
      "command": ["typescript-language-server", "--stdio"]
    }
  ]
}
```

### Configuration

#### Interactive Configuration Generator

For easy setup, use the interactive configuration generator:

```bash
# Using npx (recommended for one-time setup)
npx cclsp@latest setup

# If installed globally
cclsp setup

# Or run directly with the development version
bun run setup
```

The interactive tool will:

- Show you all available language servers
- Let you select which ones to configure with intuitive controls:
  - **Navigation**: ↑/↓ arrow keys or Ctrl+P/Ctrl+N (Emacs-style)
  - **Selection**: Space to toggle, A to toggle all, I to invert selection
  - **Confirm**: Enter to proceed
- Display installation instructions for your selected languages
- Generate the configuration file automatically
- Show you the final configuration

#### Manual Configuration

Alternatively, create an `cclsp.json` configuration file manually:

```json
{
  "servers": [
    {
      "extensions": ["py", "pyi"],
      "command": ["uvx", "--from", "python-lsp-server", "pylsp"],
      "rootDir": ".",
      "initializationOptions": {
        "settings": {
          "pylsp": {
            "plugins": {
              "jedi_completion": { "enabled": true },
              "jedi_definition": { "enabled": true },
              "jedi_hover": { "enabled": true },
              "jedi_references": { "enabled": true },
              "jedi_signature_help": { "enabled": true },
              "jedi_symbols": { "enabled": true },
              "pylint": { "enabled": false },
              "pycodestyle": { "enabled": false },
              "pyflakes": { "enabled": false }
            }
          }
        }
      }
    },
    {
      "extensions": ["js", "ts", "jsx", "tsx"],
      "command": ["npx", "--", "typescript-language-server", "--stdio"],
      "rootDir": "."
    }
  ]
}
```

**Configuration Options:**

- `extensions`: Array of file extensions this server handles
- `command`: Command array to spawn the LSP server
- `rootDir`: Working directory for the LSP server (optional, defaults to ".")
- `restartInterval`: Auto-restart interval in minutes (optional)
- `initializationOptions`: LSP server initialization options (optional)
- `tools`: Top-level map of MCP tool names to enabled status (optional; omitted tools default to enabled)

The `initializationOptions` field allows you to customize how each LSP server initializes. This is particularly useful for servers like `pylsp` (Python) that have extensive plugin configurations, or servers like `devsense-php-ls` that require specific settings.

<details>
<summary>📋 More Language Server Examples</summary>

```json
{
  "servers": [
    {
      "extensions": ["go"],
      "command": ["gopls"],
      "rootDir": "."
    },
    {
      "extensions": ["rs"],
      "command": ["rust-analyzer"],
      "rootDir": "."
    },
    {
      "extensions": ["c", "cpp", "cc", "h", "hpp"],
      "command": ["clangd"],
      "rootDir": "."
    },
    {
      "extensions": ["java"],
      "command": ["jdtls"],
      "rootDir": "."
    },
    {
      "extensions": ["rb"],
      "command": ["solargraph", "stdio"],
      "rootDir": "."
    },
    {
      "extensions": ["php"],
      "command": ["intelephense", "--stdio"],
      "rootDir": "."
    },
    {
      "extensions": ["cs"],
      "command": ["omnisharp", "-lsp"],
      "rootDir": "."
    },
    {
      "extensions": ["swift"],
      "command": ["sourcekit-lsp"],
      "rootDir": "."
    }
  ]
}
```

</details>

## 🛠️ Development

```bash
# Run in development mode
bun run dev

# Run tests
bun test

# Run manual integration test
bun run test:manual

# Lint code
bun run lint

# Format code
bun run format

# Type check
bun run typecheck
```

## 🔧 MCP Tools

The server exposes these MCP tools:

### `find_definition`

Find the definition of a symbol by name and kind in a file. Returns definitions for all matching symbols.

**Parameters:**

- `file_path`: The path to the file
- `symbol_name`: The name of the symbol
- `symbol_kind`: The kind of symbol (function, class, variable, method, etc.) (optional)

### `find_references`

Find all references to a symbol across the entire workspace. Returns references for all matching symbols.

**Parameters:**

- `file_path`: The path to the file where the symbol is defined
- `symbol_name`: The name of the symbol
- `symbol_kind`: The kind of symbol (function, class, variable, method, etc.) (optional)
- `include_declaration`: Whether to include the declaration (optional, default: true)

### `find_implementation`

Find implementations of an interface or abstract method. Returns locations of all implementations.

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)

### `rename_symbol`

Rename a symbol by name and kind in a file. **This tool now applies the rename to all affected files by default.** If multiple symbols match, returns candidate positions and suggests using rename_symbol_strict.

**Parameters:**

- `file_path`: The path to the file
- `symbol_name`: The name of the symbol
- `symbol_kind`: The kind of symbol (function, class, variable, method, etc.) (optional)
- `new_name`: The new name for the symbol
- `dry_run`: If true, only preview the changes without applying them (optional, default: false)

**Note:** When `dry_run` is false (default), the tool will:
- Apply the rename to all affected files
- Create backup files with `.bak` extension
- Return the list of modified files

### `rename_symbol_strict`

Rename a symbol at a specific position in a file. Use this when rename_symbol returns multiple candidates. **This tool now applies the rename to all affected files by default.**

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)
- `new_name`: The new name for the symbol
- `dry_run`: If true, only preview the changes without applying them (optional, default: false)

### `get_diagnostics`

Get language diagnostics (errors, warnings, hints) for a file. Uses LSP textDocument/diagnostic to pull current diagnostics.

**Parameters:**
- `file_path`: The path to the file to get diagnostics for

### `get_workspace_diagnostics`

Get diagnostics across many files in one call. Designed for cleanup workflows where an agent needs an inventory of warnings and errors across the codebase. Uses LSP `workspace/diagnostic` when the server supports it, otherwise falls back to per-file pull or `didOpen` + `publishDiagnostics`. Diagnostics are bucketed by responsible LSP server and run in parallel against a single shared wall-clock budget; partial results are reported with a clear cap-hit header instead of an error.

**Parameters:**

- `paths`: Explicit list of file paths. May be combined with `patterns`; the final file set is the union (optional)
- `patterns`: Glob patterns relative to `root`. Negation entries beginning with `!` are subtracted from the matched set (negation does NOT remove explicit `paths` entries) (optional)
- `root`: Root directory for `patterns` resolution and workspace-scope walking (optional, default: process cwd)
- `respect_gitignore`: Honor `.gitignore` when resolving `patterns` and walking the workspace (optional, default: true)
- `include_unopened`: If false, only return diagnostics for files already open in their LSP server. With workspace scope, forces per-file pull mode against open files only (optional, default: true)
- `min_severity`: One of `error`, `warning`, `information`, `hint`. Defaults to `warning` for cleanup workflows — use `error` to focus on errors only (optional, default: `warning`)
- `sources`: Whitelist of diagnostic sources, e.g. `["typescript", "eslint"]` (optional)
- `exclude_codes`: Blacklist of diagnostic codes in string form (optional)
- `max_files`: Cap on the number of files inspected. Excess files are dropped before any LSP request (optional, default: 1000, min: 1, max: 10000)
- `max_diagnostics`: Cap on the number of diagnostics rendered. Highest-severity entries win (optional, default: 500, min: 1, max: 5000)
- `max_bytes`: Hard limit on rendered output size. Oversized `by_file` output auto-falls back to `summary` (optional, default: 32768, min: 1024, max: 524288)
- `time_budget_ms`: Wall-clock budget for the whole call across every bucket (optional, default: 30000, min: 1000, max: 120000)
- `format`: One of `summary`, `by_file`, `flat`, `json` (optional, default: `by_file`)
- `group_by`: One of `file`, `code`, `source`, `severity` (optional, default: `file`)

`paths` and `patterns` may both be supplied; the resulting file set is the union, and negation entries in `patterns` only filter pattern-resolved entries (explicit `paths` always survive). If both are absent the call uses whole-workspace scope.

**Usage examples:**

Get diagnostics for three specific files:

```json
{
  "paths": [
    "src/foo.ts",
    "src/bar.py",
    "src/baz.go"
  ],
  "min_severity": "warning"
}
```

Glob pattern across the TypeScript surface, excluding tests:

```json
{
  "patterns": [
    "src/**/*.ts",
    "!src/**/*.test.ts"
  ],
  "min_severity": "error"
}
```

Whole-workspace scope (no `paths`, no `patterns`). The wall-clock budget applies, and a partial result may be returned if the budget or another cap is hit:

```json
{
  "min_severity": "warning",
  "time_budget_ms": 30000
}
```

**Cap-hit messaging:**

The tool never returns an error result for cap hits — instead, the header reports a `PARTIAL` status with one or more cap reasons (`BUDGET`, `MAX_FILES`, `MAX_DIAGNOSTICS`, `MAX_BYTES`, `SERVER_CRASH`) and the explicit guidance "do NOT retry with the same args — narrow scope":

```
get_workspace_diagnostics — PARTIAL
[!] Wall-clock budget exhausted (BUDGET): 30000 ms reached after collecting 312/?? diagnostics across 47/?? files.
[!] do NOT retry with the same args — narrow scope (use `paths` or `patterns`, or raise `time_budget_ms` up to 120000).
```

```
get_workspace_diagnostics — PARTIAL
[!] Diagnostic cap hit (MAX_DIAGNOSTICS): 500/1247 diagnostics rendered (highest severity first).
[!] do NOT retry with the same args — narrow scope (raise `min_severity` to `error`, or narrow `paths`).
```

When you see a cap-hit banner, do NOT retry the same arguments — instead, narrow the scope with `paths`/`patterns`, raise `min_severity`, or raise the relevant cap up to its documented maximum.

### `get_hover`

Get hover information (documentation, type info) for a symbol at a specific position in a file.

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)

### `find_workspace_symbols`

Search for symbols across the entire workspace by name. Returns matching symbols from all files.

**Parameters:**

- `query`: The symbol name or pattern to search for

### `prepare_call_hierarchy`

Get call hierarchy item at a position. Use this to prepare for incoming or outgoing call analysis.

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)

### `get_incoming_calls`

Find all functions or methods that call the function at a position.

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)

### `get_outgoing_calls`

Find all functions or methods called by the function at a position.

**Parameters:**

- `file_path`: The path to the file
- `line`: The line number (1-indexed)
- `character`: The character position in the line (1-indexed)

### `restart_server`

Manually restart LSP servers. Can restart servers for specific file extensions or all running servers.

**Parameters:**
- `extensions`: Array of file extensions to restart servers for (e.g., ["ts", "tsx"]). If not provided, all servers will be restarted (optional)

## 💡 Real-world Examples

### Finding Function Definitions

When Claude needs to understand how a function works:

```
Claude: Let me find the definition of the `processRequest` function
> Using cclsp.find_definition with symbol_name="processRequest", symbol_kind="function"

Result: Found definition at src/handlers/request.ts:127:1
```

### Finding All References

When refactoring or understanding code impact:

```
Claude: I'll find all places where `CONFIG_PATH` is used
> Using cclsp.find_references with symbol_name="CONFIG_PATH"

Results: Found 5 references:
- src/config.ts:10:1 (declaration)
- src/index.ts:45:15
- src/utils/loader.ts:23:8
- tests/config.test.ts:15:10
- tests/config.test.ts:89:12
```

### Renaming Symbols

Safe refactoring across the entire codebase (now with actual file modification!):

```
Claude: I'll rename `getUserData` to `fetchUserProfile`
> Using cclsp.rename_symbol with symbol_name="getUserData", new_name="fetchUserProfile"

Result: Successfully renamed getUserData (function) to "fetchUserProfile".

Modified files:
- src/api/user.ts
- src/services/auth.ts
- src/components/UserProfile.tsx
... (12 files total)
```

Preview changes before applying (using dry_run):

```
Claude: Let me first preview what will be renamed
> Using cclsp.rename_symbol with symbol_name="getUserData", new_name="fetchUserProfile", dry_run=true

Result: [DRY RUN] Would rename getUserData (function) to "fetchUserProfile":
File: src/api/user.ts
  - Line 55, Column 10 to Line 55, Column 21: "fetchUserProfile"
File: src/services/auth.ts
  - Line 123, Column 15 to Line 123, Column 26: "fetchUserProfile"
... (12 files total)
```

When multiple symbols match:

```
Claude: I'll rename the `data` variable to `userData`
> Using cclsp.rename_symbol with symbol_name="data", new_name="userData"

Result: Multiple symbols found matching "data". Please use rename_symbol_strict with one of these positions:
- data (variable) at line 45, character 10
- data (parameter) at line 89, character 25
- data (property) at line 112, character 5

> Using cclsp.rename_symbol_strict with line=45, character=10, new_name="userData"

Result: Successfully renamed symbol at line 45, character 10 to "userData".

Modified files:
- src/utils/parser.ts
```

### Checking File Diagnostics

When analyzing code quality:

```
Claude: Let me check for any errors or warnings in this file
> Using cclsp.get_diagnostics

Results: Found 3 diagnostics:
- Error [TS2304]: Cannot find name 'undefinedVar' (Line 10, Column 5)
- Warning [no-unused-vars]: 'config' is defined but never used (Line 25, Column 10)
- Hint: Consider using const instead of let (Line 30, Column 1)
```

### Restarting LSP Servers

When LSP servers become unresponsive or configuration changes:

```
Claude: The TypeScript server seems unresponsive, let me restart it
> Using cclsp.restart_server with extensions ["ts", "tsx"]

Result: Successfully restarted 1 LSP server(s)
Restarted servers:
• typescript-language-server --stdio (ts, tsx)
```

Or restart all servers:

```
Claude: I'll restart all LSP servers to ensure they're working properly
> Using cclsp.restart_server

Result: Successfully restarted 2 LSP server(s)
Restarted servers:
• typescript-language-server --stdio (ts, tsx)
• pylsp (py)
```

## 🔍 Troubleshooting

### Known Issues

<details>
<summary>🐍 Python LSP Server (pylsp) Performance Degradation</summary>

**Problem**: The Python Language Server (pylsp) may become slow or unresponsive after extended use (several hours), affecting symbol resolution and code navigation.

**Symptoms**:
- Slow or missing "go to definition" results for Python files
- Delayed or incomplete symbol references
- General responsiveness issues with Python code analysis

**Solution**: Use the auto-restart feature to periodically restart the pylsp server:

Add `restartInterval` to your Python server configuration:

```json
{
  "servers": [
    {
      "extensions": ["py", "pyi"],
      "command": ["pylsp"],
      "restartInterval": 5
    }
  ]
}
```

This will automatically restart the Python LSP server every 5 minutes, maintaining optimal performance for long coding sessions.

**Alternative**: You can also manually restart servers using the `restart_server` tool when needed:
- Restart specific server: `restart_server` with `extensions: ["py"]`
- Restart all servers: `restart_server` without parameters

**Note**: The setup wizard automatically configures this for Python servers when detected.

</details>

### Common Issues

<details>
<summary>🔧 LSP server not starting</summary>

**Problem**: Error message about LSP server not found

**Solution**: Ensure the language server is installed:

```bash
# For TypeScript
npm install -g typescript-language-server

# For Python
pip install python-lsp-server

# For Go
go install golang.org/x/tools/gopls@latest
```

</details>

<details>
<summary>🔧 Configuration not loading</summary>

**Problem**: cclsp uses default TypeScript configuration only

**Solution**: Check that:

1. Your config file is named `cclsp.json` (not `cclsp.config.json`)
2. The `CCLSP_CONFIG_PATH` environment variable points to the correct file
3. The JSON syntax is valid
</details>

<details>
<summary>🔧 Symbol not found errors</summary>

**Problem**: "Go to definition" returns no results

**Solution**:

1. Ensure the file is saved and part of the project
2. Check that the language server supports the file type
3. Some language servers need a few seconds to index the project
</details>

## 🤝 Contributing

We welcome contributions! Here's how you can help:

### Reporting Issues

Found a bug or have a feature request? [Open an issue](https://github.com/ktnyt/cclsp/issues) with:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node version, etc.)

### Adding Language Support

Want to add support for a new language?

1. Find the LSP server for your language
2. Test the configuration locally
3. Submit a PR with:
   - Updated README examples
   - Test files if possible
   - Configuration documentation

### Code Contributions

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Run tests: `bun test`
5. Commit: `git commit -m '✨ feat: add amazing feature'`
6. Push: `git push origin feature/amazing-feature`
7. Open a Pull Request

## 📄 License

MIT
