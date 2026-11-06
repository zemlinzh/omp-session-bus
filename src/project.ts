import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export interface ProjectScope {
  id: string;
  name: string;
  root: string;
  repository: string | null;
  relativeRoot: string;
}

interface Repository {
  worktree: string;
  common: string;
}

const runFile = promisify(execFile);

function identityPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function descendantPath(parent: string, child: string): string | null {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ? null : path;
}

async function directory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
    return canonical;
  } catch (error) {
    throw new Error(`Cannot resolve ${label} directory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function repositoryAt(cwd: string): Promise<Repository | null> {
  let stdout: string;
  try {
    // Repository identity belongs to cwd, not an inherited Git command context.
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    ({ stdout } = await runFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      encoding: "utf8", env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    const stderr = failure.stderr?.trim() ?? "";
    if (typeof failure.code === "number" && !failure.killed && !failure.signal && /^fatal: not a git repository(?:\s|:|$)/m.test(stderr)) return null;
    throw new Error(`Cannot determine Git repository for ${JSON.stringify(cwd)}: ${stderr || failure.message}. Check Git installation, repository permissions and configuration.`, { cause: error });
  }
  // Git emits one absolute path per requested value. Do not trim path whitespace.
  const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length !== 2 || !lines.every(path => isAbsolute(path))) {
    throw new Error(`Cannot determine Git repository for ${JSON.stringify(cwd)}: expected two absolute paths from git rev-parse; paths containing newlines are unsupported.`);
  }
  const [worktree, common] = await Promise.all([
    directory(lines[0]!, "Git worktree"),
    directory(lines[1]!, "Git common"),
  ]);
  if (descendantPath(worktree, cwd) === null) {
    throw new Error(`Git worktree ${JSON.stringify(worktree)} does not contain cwd ${JSON.stringify(cwd)}.`);
  }
  return { worktree, common };
}

function scope(root: string, repository: Repository | null, logicalPath: string): ProjectScope {
  const relativeRoot = logicalPath === "" ? "." : logicalPath.split(sep).join("/");
  const identity = repository ? ["git", identityPath(repository.common), identityPath(relativeRoot)] : ["directory", identityPath(root)];
  const id = `project-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
  const repositoryName = repository && (identityPath(basename(repository.common)) === ".git" ? basename(dirname(repository.common)) : basename(repository.common));
  return {
    id,
    name: relativeRoot !== "." || !repository ? basename(root) || root : repositoryName!,
    root,
    repository: repository?.common ?? null,
    relativeRoot,
  };
}

/** Resolve the physical repository and logical subproject containing this session. */
export async function resolveProject(cwd: string, explicitProjectRoot?: string): Promise<ProjectScope> {
  if (!cwd.trim()) throw new Error("Project cwd must not be empty.");
  if (explicitProjectRoot !== undefined && !explicitProjectRoot.trim()) throw new Error("Explicit project root must not be empty.");
  const current = await directory(cwd, "cwd");
  const repository = await repositoryAt(current);
  if (explicitProjectRoot === undefined) return scope(repository?.worktree ?? current, repository, "");

  const requested = await directory(resolve(repository?.worktree ?? current, explicitProjectRoot), "explicit project root");
  if (!repository) {
    if (descendantPath(requested, current) === null) {
      throw new Error(`Explicit project root ${JSON.stringify(requested)} does not contain cwd ${JSON.stringify(current)}.`);
    }
    return scope(requested, null, "");
  }

  let logicalPath = descendantPath(repository.worktree, requested);
  if (logicalPath === null) {
    const sourceRepository = await repositoryAt(requested);
    if (!sourceRepository || identityPath(sourceRepository.common) !== identityPath(repository.common)) {
      throw new Error(`Explicit project root ${JSON.stringify(requested)} belongs to a different repository than cwd ${JSON.stringify(current)}.`);
    }
    logicalPath = descendantPath(sourceRepository.worktree, requested);
    if (logicalPath === null) throw new Error(`Explicit project root ${JSON.stringify(requested)} is outside its Git worktree.`);
  }
  const mappedRoot = await directory(resolve(repository.worktree, logicalPath), "mapped project root");
  const mappedPath = descendantPath(repository.worktree, mappedRoot);
  if (mappedPath === null) {
    throw new Error(`Mapped project root ${JSON.stringify(mappedRoot)} is outside the current Git worktree.`);
  }
  if (identityPath(mappedPath) !== identityPath(logicalPath)) {
    throw new Error(`Mapped project root ${JSON.stringify(mappedRoot)} does not match logical project path ${JSON.stringify(logicalPath)} in the current Git worktree.`);
  }
  if (descendantPath(mappedRoot, current) === null) {
    throw new Error(`Explicit project root maps to ${JSON.stringify(mappedRoot)}, which does not contain cwd ${JSON.stringify(current)}.`);
  }
  return scope(mappedRoot, repository, logicalPath);
}
