import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const MIN_LINES = numberFromEnv("AST_OUTLINE_MIN_LINES", 200);
const ALWAYS_READ_HOOK = boolFromEnv("AST_OUTLINE_ALWAYS", false);
const READ_HOOK_ENABLED = boolFromEnv("AST_OUTLINE_READ_HOOK", true);
const AST_OUTLINE_BIN = process.env.AST_OUTLINE_BIN || "ast-outline";

const COMMON_PARAMS = {
  json: Type.Optional(Type.Boolean({ description: "Return JSON instead of text." })),
  rebuild: Type.Optional(Type.Boolean({ description: "Drop the cached graph/index and rebuild before querying." })),
  path_root: Type.Optional(Type.String({ description: "Repo root; default '.'." })),
};

const SUPPORTED_EXTENSIONS = new Set([
  "rs",
  "cs",
  "py",
  "pyi",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "java",
  "kt",
  "kts",
  "scala",
  "sc",
  "go",
  "md",
  "markdown",
  "mdx",
  "mdown",
]);

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function addBool(args: string[], flag: string, value: unknown) {
  if (value === true) args.push(flag);
}

function addOptional(args: string[], flag: string, value: unknown) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(flag, String(value));
  }
}

function addRepeated(args: string[], flag: string, values: unknown) {
  if (!Array.isArray(values)) return;
  for (const value of values) args.push(flag, String(value));
}

async function runAstOutline(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(AST_OUTLINE_BIN, args, {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, termSignal) => {
      if (code === 0) {
        resolveOutput(stdout.trimEnd());
        return;
      }
      const suffix = stderr.trim() || stdout.trim() || `exit ${code ?? termSignal ?? "unknown"}`;
      reject(new Error(`ast-outline ${args.join(" ")} failed: ${suffix}`));
    });
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

async function lineCountAtLeast(path: string, threshold: number): Promise<boolean> {
  if (threshold <= 0) return true;
  const meta = await stat(path);
  // Cheap lower bound copied from ast-outline's native hook: a file with fewer
  // bytes than the threshold cannot have threshold lines.
  if (meta.size < threshold) return false;

  return new Promise((resolveResult, reject) => {
    let lines = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("data", (chunk) => {
      const text = String(chunk);
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
          lines++;
          if (lines >= threshold) {
            stream.destroy();
            resolveResult(true);
            return;
          }
        }
      }
    });
    stream.on("error", reject);
    stream.on("close", () => resolveResult(lines >= threshold));
  });
}

function supportedByAstOutline(path: string): boolean {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SUPPORTED_EXTENSIONS.has(name.slice(dot + 1));
}

const readToolCache = new Map<string, ReturnType<typeof createReadTool>>();
function getReadTool(cwd: string) {
  let tool = readToolCache.get(cwd);
  if (!tool) {
    tool = createReadTool(cwd);
    readToolCache.set(cwd, tool);
  }
  return tool;
}

function registerReadHook(pi: ExtensionAPI) {
  const schemaTool = getReadTool(process.cwd());
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      schemaTool.description +
      " When pi-ast-outline is loaded, full reads of large supported source files are automatically substituted with an ast-outline structural map; re-read with offset/limit to get raw file contents.",
    parameters: schemaTool.parameters,
    promptGuidelines: [
      "When the read tool returns an ast-outline substitution, use extract_symbol_body or re-read with offset/limit before editing a function body.",
    ],

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const originalRead = getReadTool(ctx.cwd);
      const p = params as { path?: string; offset?: number; limit?: number };
      const rawPath = typeof p.path === "string" ? stripAtPrefix(p.path) : "";

      if (
        !READ_HOOK_ENABLED ||
        !rawPath ||
        p.offset !== undefined ||
        p.limit !== undefined ||
        !supportedByAstOutline(rawPath)
      ) {
        return originalRead.execute(toolCallId, params, signal, onUpdate);
      }

      const absolutePath = resolve(ctx.cwd, rawPath);
      try {
        if (!ALWAYS_READ_HOOK && !(await lineCountAtLeast(absolutePath, MIN_LINES))) {
          return originalRead.execute(toolCallId, params, signal, onUpdate);
        }

        const outline = await runAstOutline(["map", rawPath], ctx.cwd, signal);
        return textResult(
          `${outline}\n# ast-outline substituted full file. Re-read with offset/limit, or\n# use extract_symbol_body for a body.`,
          { astOutlineSubstituted: true, path: rawPath },
        );
      } catch {
        // Match the native hook's fail-open behaviour: if ast-outline cannot
        // parse/run, preserve normal read semantics instead of breaking reads.
        return originalRead.execute(toolCallId, params, signal, onUpdate);
      }
    },
  });
}

const pathsSchema = Type.Array(Type.String(), {
  minItems: 1,
  description: "Files or directories to inspect.",
});

function registerAstTool(
  pi: ExtensionAPI,
  name: string,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
  buildArgs: (params: Record<string, unknown>) => string[],
  promptSnippet?: string,
  guidelines?: string[],
) {
  pi.registerTool({
    name,
    label: name,
    description,
    promptSnippet,
    promptGuidelines: guidelines,
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = buildArgs(params as Record<string, unknown>);
      const output = await runAstOutline(args, ctx.cwd, signal);
      return textResult(output, { command: [AST_OUTLINE_BIN, ...args] });
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerReadHook(pi);

  registerAstTool(
    pi,
    "map_source_structure",
    "Structural map of source files: signatures and line ranges, no bodies. Prefer over read for large files (5–10× smaller).",
    Type.Object({
      paths: pathsSchema,
      no_private: Type.Optional(Type.Boolean({ description: "Hide private declarations." })),
      no_fields: Type.Optional(Type.Boolean({ description: "Hide field declarations." })),
      no_docs: Type.Optional(Type.Boolean({ description: "Hide doc comments." })),
      no_attrs: Type.Optional(Type.Boolean({ description: "Hide attributes / decorators." })),
      no_lines: Type.Optional(Type.Boolean({ description: "Hide line-range suffixes." })),
      glob: Type.Optional(Type.String({ description: "Glob filter applied during directory walk." })),
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["map", ...(p.paths as string[])];
      addBool(args, "--no-private", p.no_private);
      addBool(args, "--no-fields", p.no_fields);
      addBool(args, "--no-docs", p.no_docs);
      addBool(args, "--no-attrs", p.no_attrs);
      addBool(args, "--no-lines", p.no_lines);
      addOptional(args, "--glob", p.glob);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Map files/directories to signatures and line ranges without reading bodies.",
    ["Prefer map_source_structure over read for large files.", "Use code navigation tools (map_source_structure, overview_code, extract_symbol_body, find_callers, imports_of, imported_by) for source structure and relationships. Prefer grep for exact strings and bash for shell/runtime/VCS.", "When using map_source_structure use the most restrictive flags that gets the info you need (i.e. --no-fields, --no-private, etc.)."],
  );

  registerAstTool(
    pi,
    "overview_code",
    "One-page structural overview of a directory but also single files — all types and their public methods. Very compact output.",
    Type.Object({
      paths: pathsSchema,
      include_private: Type.Optional(Type.Boolean()),
      include_fields: Type.Optional(Type.Boolean()),
      max_members: Type.Optional(Type.Integer({ description: "Cap members per type; default 50." })),
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["digest", ...(p.paths as string[])];
      addBool(args, "--include-private", p.include_private);
      addBool(args, "--include-fields", p.include_fields);
      addOptional(args, "--max-members", p.max_members);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Summarize a directory's files, types, and public methods.",
    ["Use overview_code when entering unfamiliar code and you need to know what is there and where to start looking.", "Use overview_code to know what types and methods exist when you don't need exact implementation immediately."],
  );

  registerAstTool(
    pi,
    "extract_symbol_body",
    "Extract the full source body of one or more symbols from a file. Suffix-match: TakeDamage or Player.TakeDamage. In markdown, symbols are headings.",
    Type.Object({
      path: Type.String({ description: "File to search." }),
      symbols: Type.Array(Type.String(), { minItems: 1, description: "One or more symbols to extract." }),
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["show", p.path as string, ...((p.symbols as string[]) ?? [])];
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Extract the body/source for specific symbols from a file.",
    ["Use extract_symbol_body when you know which symbol you need.", "Prefer extract_symbol_body over reading a whole source file after you've identified the target symbol."],
  );

  registerAstTool(
    pi,
    "find_implementations",
    "Find subclasses and implementations of a type. Transitive by default; set direct: true for immediate subtypes only.",
    Type.Object({
      target: Type.String({ description: "Type name to look up." }),
      paths: pathsSchema,
      direct: Type.Optional(Type.Boolean({ description: "Direct subtypes only." })),
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["implements", p.target as string, ...(p.paths as string[])];
      addBool(args, "--direct", p.direct);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Find subclasses or implementations of a type.",
  );

  registerAstTool(
    pi,
    "show_public_api",
    "Compute the true public API surface, resolving Rust pub use re-exports and Python __all__. Use before read to understand a package's interface.",
    Type.Object({
      path: Type.Optional(Type.String({ description: "Crate root, package init, or directory; default '.'." })),
      tree: Type.Optional(Type.Boolean({ description: "Render as a hierarchical tree grouped by module." })),
      include_chain: Type.Optional(Type.Boolean()),
      max_depth: Type.Optional(Type.Integer({ description: "Recursion guard; default 16." })),
      include_private: Type.Optional(Type.Boolean()),
      lang: Type.Optional(Type.String({ description: "Force resolver: rust, python, or fallback." })),
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["surface", (p.path as string | undefined) ?? "."];
      addBool(args, "--tree", p.tree);
      addBool(args, "--include-chain", p.include_chain);
      addOptional(args, "--max-depth", p.max_depth);
      addBool(args, "--include-private", p.include_private);
      addOptional(args, "--lang", p.lang);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Show the true public API surface of a package/module.",
    ["Use show_public_api to discover public entrypoints into a package or module."],
  );

  registerAstTool(
    pi,
    "imports_of",
    "Forward import-graph traversal: what does this file import transitively? Builds and reuses a per-repo dependency graph.",
    Type.Object({
      file: Type.String({ description: "Path to the file whose imports to follow." }),
      depth: Type.Optional(Type.Integer({ minimum: 1, description: "Max BFS depth; default 3." })),
      external: Type.Optional(Type.Boolean({ description: "Include unresolved external imports." })),
      rebuild: COMMON_PARAMS.rebuild,
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["deps", p.file as string];
      addOptional(args, "--depth", p.depth);
      addBool(args, "--external", p.external);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Traverse what a file imports.",
  );

  registerAstTool(
    pi,
    "imported_by",
    "Find all files that import a target file (transitive). Use to assess refactor blast radius.",
    Type.Object({
      file: Type.String({ description: "Path to the file whose importers to find." }),
      depth: Type.Optional(Type.Integer({ minimum: 1, description: "Max BFS depth; default 3." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Cap result count; default 200." })),
      rebuild: COMMON_PARAMS.rebuild,
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["reverse-deps", p.file as string];
      addOptional(args, "--depth", p.depth);
      addOptional(args, "--limit", p.limit);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Find files that import a target file.",
    ["Use imports_of and imported_by for module-boundary changes, file moves, dependency cleanup, or estimating refactor blast radius. Not needed for local function-body edits."],
  );

  registerAstTool(
    pi,
    "detect_import_cycles",
    "Find import cycles via Tarjan strongly-connected components. Use before refactoring to uncover dependency tangles.",
    Type.Object({
      path: COMMON_PARAMS.path_root,
      min_size: Type.Optional(Type.Integer({ minimum: 1, description: "Drop SCCs smaller than this; default 2." })),
      rebuild: COMMON_PARAMS.rebuild,
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["cycles", (p.path as string | undefined) ?? "."];
      addOptional(args, "--min-size", p.min_size);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Find dependency/import cycles.",
  );

  registerAstTool(
    pi,
    "show_dependency_graph",
    "Emit the file-level dependency graph of the repo in text or JSON format.",
    Type.Object({
      path: COMMON_PARAMS.path_root,
      json: COMMON_PARAMS.json,
      include_external: Type.Optional(Type.Boolean({ description: "Include unresolved imports in JSON output." })),
      rebuild: COMMON_PARAMS.rebuild,
    }),
    (p) => {
      const args = ["graph", (p.path as string | undefined) ?? "."];
      addBool(args, "--json", p.json);
      addBool(args, "--include-external", p.include_external);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Emit the file-level dependency graph.",
  );

  registerAstTool(
    pi,
    "find_callers",
    "Find callers of a symbol — AST-accurate, no grep noise. Suffix-matches: TakeDamage, Type.method, or file:Symbol.",
    Type.Object({
      target: Type.String({ description: "Symbol name to look up." }),
      path: COMMON_PARAMS.path_root,
      depth: Type.Optional(Type.Integer({ minimum: 1, description: "Max BFS depth; default 1." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Cap result count; default 200." })),
      include_ambiguous: Type.Optional(Type.Boolean({ description: "Keep callers whose target is unresolved." })),
      rebuild: COMMON_PARAMS.rebuild,
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["callers", p.target as string, (p.path as string | undefined) ?? "."];
      addOptional(args, "--depth", p.depth);
      addOptional(args, "--limit", p.limit);
      addBool(args, "--include-ambiguous", p.include_ambiguous);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Find who calls a symbol.",
    ["Use find_callers before changing a symbol's name, visibility, signature, or behavior contract."],
  );

  registerAstTool(
    pi,
    "find_callees",
    "What does this symbol call? — AST-accurate forward call traversal. Suffix-matches like callers.",
    Type.Object({
      target: Type.String({ description: "Symbol name to look up." }),
      path: COMMON_PARAMS.path_root,
      depth: Type.Optional(Type.Integer({ minimum: 1, description: "Max BFS depth; default 1." })),
      external: Type.Optional(Type.Boolean({ description: "Include unresolved/external callees." })),
      rebuild: COMMON_PARAMS.rebuild,
      json: COMMON_PARAMS.json,
    }),
    (p) => {
      const args = ["callees", p.target as string, (p.path as string | undefined) ?? "."];
      addOptional(args, "--depth", p.depth);
      addBool(args, "--external", p.external);
      addBool(args, "--rebuild", p.rebuild);
      addBool(args, "--json", p.json);
      addBool(args, "--compact", p.json);
      return args;
    },
    "Find what a symbol calls.",
  );
}
