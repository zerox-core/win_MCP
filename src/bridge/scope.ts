/**
 * Session-scoped filesystem confinement for the bridge.
 *
 * Why this exists: the server's `ALLOWED_DIRS` is an operator setting that is
 * usually broad enough to be useful (a whole projects folder, sometimes a
 * drive). A hosted model is an untrusted input source — a payload in a file or
 * web page it reads can try to steer it. If the model can be talked into
 * reading `F:\Projects\other-client\secrets`, `ALLOWED_DIRS` will not stop it,
 * because that path is legitimately allowed.
 *
 * This layer narrows the boundary per run: the operator names the subtree the
 * task actually touches, and any tool call whose path argument falls outside it
 * is refused *before* it reaches the server. Nothing here replaces the server's
 * own checks; it only shrinks the window.
 *
 * Two rules keep it honest:
 *   - Escalation is denied by default; there is no "just this once".
 *   - A refusal is explained to the model so it can ask the user, rather than
 *     silently failing and looping.
 */

import path from "node:path";

/**
 * Argument names that carry a filesystem location.
 *
 * Derived from the live tool inventory; kept explicit rather than inferred from
 * names like /path/ so that `content`, `oldText`, `targets`, and `profileId`
 * are not mistaken for paths.
 */
const PATH_ARGUMENTS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  create_directory: ["path"],
  list_directory: ["path"],
  get_file_info: ["path"],
  search_files: ["path"],
  search_content: ["path"],
  apply_patch: ["path"],
  git_status: ["path"],
  git_diff: ["path", "file"],
  compare_files: ["path_a", "path_b"],
  move_file: ["source", "destination"],
  execute_command: ["workdir"],
  java_development: ["workdir"],
  node_development: ["workdir"],
  python_development: ["workdir"],
  windows_development: ["workdir"],
  android_development: ["workdir"],
  run_local_workflow: ["testFiles"],
  staging_android_verify: ["workdir", "apkPath"],
};

/**
 * Tools whose effect cannot be confined by inspecting path arguments.
 *
 * `execute_command` can touch anything the shell can, regardless of `workdir`;
 * a nested `cd` or an absolute path in the command string defeats path checks.
 * When a scope is active these are refused unless the operator opted in, because
 * pretending the scope covers them would be worse than saying so.
 */
const SCOPE_DEFEATING_TOOLS = new Set(["execute_command"]);

export interface ScopeOptions {
  /** Directories the session may touch. Empty/undefined disables the layer. */
  roots?: string[];
  /**
   * Allow scope-defeating tools (currently execute_command) even though their
   * effects cannot be verified against the scope.
   */
  allowUnconfinedTools?: boolean;
  /** Injected for tests. */
  resolvePath?: (value: string) => string;
}

export interface ScopeDecision {
  allowed: boolean;
  /** Human-readable reason; shown to the model when refused. */
  reason?: string;
  /** The offending path, when one was found. */
  offendingPath?: string;
}

function normalize(value: string): string {
  return path.resolve(value);
}

/** True when `candidate` is `root` itself or lives inside it. */
export function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class SessionScope {
  private readonly roots: string[];
  private readonly allowUnconfinedTools: boolean;
  private readonly resolvePath: (value: string) => string;

  constructor(options: ScopeOptions = {}) {
    this.roots = (options.roots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => normalize(root));
    this.allowUnconfinedTools = options.allowUnconfinedTools ?? false;
    this.resolvePath = options.resolvePath ?? ((value: string) => normalize(value));
  }

  /** The layer is inert unless the operator named at least one root. */
  get active(): boolean {
    return this.roots.length > 0;
  }

  get scopeRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Check one tool call.
   *
   * Returns `allowed: true` when the layer is inactive, when the tool takes no
   * path arguments, and when every path it does take is inside the scope.
   */
  check(toolName: string, args: Record<string, unknown>): ScopeDecision {
    if (!this.active) return { allowed: true };

    if (SCOPE_DEFEATING_TOOLS.has(toolName) && !this.allowUnconfinedTools) {
      return {
        allowed: false,
        reason:
          `${toolName} can affect files outside this session's scope, so it is blocked while a ` +
          `scope is active. Ask the user to run it themselves, or restart the bridge without ` +
          `MCP_BRIDGE_SCOPE, or with MCP_BRIDGE_SCOPE_ALLOW_EXEC=1 to accept the risk.`,
      };
    }

    const pathArgs = PATH_ARGUMENTS[toolName];
    if (!pathArgs) return { allowed: true };

    for (const key of pathArgs) {
      const raw = args[key];
      const candidates = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || candidate.trim() === "") continue;
        const resolved = this.resolvePath(candidate);
        if (!this.roots.some((root) => isInside(resolved, root))) {
          return {
            allowed: false,
            reason:
              `"${resolved}" is outside this session's scope ` +
              `(${this.roots.join(", ")}). Only those directories are reachable in this run; ` +
              `tell the user what else is needed instead of retrying other paths.`,
            offendingPath: resolved,
          };
        }
      }
      // A tool that needs a path and got none will fail server-side validation;
      // letting that error through produces a better message than guessing.
    }

    return { allowed: true };
  }

  /** Render the scope for the startup banner. */
  describe(): string {
    return this.active ? this.roots.join(", ") : "(unrestricted)";
  }
}
