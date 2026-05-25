# pi-ast-outline

Pi extension that exposes [`ast-outline`](https://github.com/aeroxy/ast-outline) as first-class Pi tools and overrides Pi's `read` tool with an ast-outline-style large-file substitution hook.

## Tools

Registers one Pi tool per ast-outline command:

| ast-outline command | Pi tool name |
|---|---|
| `map` | `map_source_structure` |
| `digest` | `overview_code` |
| `show` | `extract_symbol_body` |
| `implements` | `find_implementations` |
| `surface` | `show_public_api` |
| `deps` | `imports_of` |
| `reverse-deps` | `imported_by` |
| `cycles` | `detect_import_cycles` |
| `graph` | `show_dependency_graph` |
| `callers` | `find_callers` |
| `callees` | `find_callees` |

`index`, `search`, and `find-related` are omitted for now — the index only backs search-related commands, and those result sets often overflow the LLM context window.

The tool descriptions and usage guidelines are inlined in the registration calls rather than sourced from ast-outline's MCP catalogue.

## Read hook analogue

When the extension is loaded, it overrides Pi's built-in `read` tool. Full reads of large supported source files are replaced by:

```bash
ast-outline map <file>
```

It delegates to the original `read` tool when:

- `AST_OUTLINE_READ_HOOK=0`
- `offset` or `limit` is provided
- the file extension is unsupported
- the file has fewer than `AST_OUTLINE_MIN_LINES` lines, unless `AST_OUTLINE_ALWAYS=1`
- `ast-outline map` fails

This is runtime-only. It does not modify `AGENTS.md`, prompts, or project files.

## Prerequisites

- The `bash` tool must be enabled (it is by default).
- [`ast-outline`](https://github.com/aeroxy/ast-outline#install) must be installed and on `PATH`.

## Install

**Try it once** (no permanent install):

```bash
# local clone
pi -e ~/projects/AI/pi_extensions/pi-ast-outline

# via git (no clone needed)
pi -e git:github.com/<user>/pi-ast-outline
```

**Install permanently** (auto-loads every session):

```bash
# local path
pi install ~/projects/AI/pi_extensions/pi-ast-outline

# via git
pi install git:github.com/<user>/pi-ast-outline
```

If you cloned locally, run `npm install` inside the package directory first so TypeScript type definitions are available.

Optional env vars:

```bash
AST_OUTLINE_BIN=ast-outline          # binary to execute
AST_OUTLINE_MIN_LINES=200            # read substitution threshold
AST_OUTLINE_ALWAYS=1                 # substitute even small supported files
AST_OUTLINE_READ_HOOK=0              # disable read override behavior
```

## Development

```bash
npm run check
```

## For the ast-outline maintainer

If you're the maintainer of ast-outline, feel free to copy anything from this extension when integrating Pi support natively.
# pi-ast-outline
