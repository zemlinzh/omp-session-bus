import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { PROJECT_ID_PATTERN } from "../src/protocol.js";
import { resolveProject } from "../src/project.js";

const runFile = promisify(execFile);
const roots: string[] = [];

// No fixture depends on, or changes, the user's Git identity or signing setup.
async function git(cwd: string, ...args: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(cwd, "no-test-gitconfig");
  env.GIT_TERMINAL_PROMPT = "0";
  await runFile("git", ["-C", cwd, "-c", "user.name=Session Bus Test", "-c", "user.email=session-bus-test@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(cwd, "no-test-hooks")}`, ...args], {
    encoding: "utf8", env, windowsHide: true, timeout: 10_000,
  });
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-project-test-"));
  roots.push(root);
  return root;
}

async function repository(base: string, name = "main repo α"): Promise<string> {
  const root = join(base, name);
  await mkdir(join(root, "apps", "A", "nested"), { recursive: true });
  await mkdir(join(root, "apps", "B"), { recursive: true });
  await writeFile(join(root, "apps", "A", "nested", "tracked.txt"), "A\n");
  await writeFile(join(root, "apps", "B", "tracked.txt"), "B\n");
  await git(root, "init", "-b", "main");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Seed isolated project fixture");
  return root;
}

async function worktrees(): Promise<{ base: string; main: string; inner: string; external: string }> {
  const base = await temporary();
  const main = await repository(base);
  const inner = join(main, ".worktrees", "内部 α 你好");
  const external = join(base, "external worktree β 日本語 👋");
  await git(main, "worktree", "add", "-b", "inner", inner);
  await git(main, "worktree", "add", "-b", "external", external);
  return { base, main, inner, external };
}

afterEach(async () => {
  const outcomes = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, "Failed to clean up isolated project fixtures");
});

describe("physical repository and logical project identity", () => {
  test("groups repository roots, descendants, internal and external linked worktrees", async () => {
    const { main, inner, external } = await worktrees();
    const expected = await resolveProject(main);
    expect(expected).toMatchObject({
      name: "main repo α", root: await realpath(main), repository: await realpath(join(main, ".git")), relativeRoot: ".",
    });
    expect(expected.id).toMatch(PROJECT_ID_PATTERN);
    for (const root of [main, inner, external]) {
      for (const cwd of [root, join(root, "apps", "A", "nested")]) {
        const result = await resolveProject(cwd);
        expect(result.id).toBe(expected.id);
        expect(result.name).toBe(expected.name);
        expect(result.repository).toBe(expected.repository);
        expect(result.root).toBe(await realpath(root));
        expect(result.relativeRoot).toBe(".");
      }
    }
  }, 30_000);

  test("isolates other repositories and independent clones with identical history", async () => {
    const base = await temporary();
    const main = await repository(base);
    const other = await repository(base, "other repo");
    const clone = join(base, "independent clone");
    await git(base, "clone", "--no-hardlinks", main, clone);
    const original = await resolveProject(main);
    const unrelated = await resolveProject(other);
    const cloned = await resolveProject(clone);
    expect(new Set([original.id, unrelated.id, cloned.id]).size).toBe(3);
    expect(cloned.repository).not.toBe(original.repository);
  }, 20_000);

  test("maps explicit relative subprojects across worktrees and separates siblings", async () => {
    const { main, inner, external } = await worktrees();
    const a = await resolveProject(join(main, "apps", "A", "nested"), "apps/A");
    const b = await resolveProject(join(main, "apps", "B"), "apps/B");
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe((await resolveProject(main)).id);
    expect(a).toMatchObject({ name: "A", root: await realpath(join(main, "apps", "A")), relativeRoot: "apps/A" });
    for (const root of [inner, external]) {
      const mapped = await resolveProject(join(root, "apps", "A", "nested"), "apps/A");
      expect(mapped.id).toBe(a.id);
      expect(mapped.root).toBe(await realpath(join(root, "apps", "A")));
      expect(mapped.name).toBe(a.name);
    }
  }, 30_000);

  test("maps absolute roots from the main and other linked worktrees into the current worktree", async () => {
    const { main, inner, external } = await worktrees();
    const expected = await resolveProject(join(main, "apps", "A"), "apps/A");
    for (const [current, source] of [[inner, main], [external, main], [main, external], [external, inner]] as const) {
      const mapped = await resolveProject(join(current, "apps", "A", "nested"), join(source, "apps", "A"));
      expect(mapped.id).toBe(expected.id);
      expect(mapped.root).toBe(await realpath(join(current, "apps", "A")));
    }
    const root = await resolveProject(join(inner, "apps", "A"), main);
    expect(root.id).toBe((await resolveProject(main)).id);
    expect(root.root).toBe(await realpath(inner));
  }, 30_000);

  test("uses canonical physical paths for aliases without changing the repository identity", async () => {
    const base = await temporary();
    const main = await repository(base);
    const alias = join(base, "repository alias");
    await symlink(main, alias, process.platform === "win32" ? "junction" : "dir");
    const expected = await resolveProject(join(main, "apps", "A"), "apps/A");
    expect(await resolveProject(join(alias, "apps", "A", "nested"), join(alias, "apps", "A"))).toEqual(expected);
    expect((await resolveProject(alias)).id).toBe((await resolveProject(main)).id);
  }, 20_000);

  test("maps Unicode logical roots across linked worktrees and physical aliases", async () => {
    const base = await temporary();
    const main = await repository(base);
    const logical = join("apps", "模块 α 👋");
    const nested = "子目录 β";
    await mkdir(join(main, logical, nested), { recursive: true });
    await writeFile(join(main, logical, nested, "文件.txt"), "Unicode worktree fixture\n");
    await git(main, "add", ".");
    await git(main, "commit", "-m", "Add Unicode logical project");
    const external = join(base, "工作树 β 👋");
    await git(main, "worktree", "add", "-b", "unicode", external);
    const mainAlias = join(base, "主仓库 alias 你好");
    const externalAlias = join(base, "工作树 alias 日本語 👋");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(main, mainAlias, linkType);
    await symlink(external, externalAlias, linkType);
    const expected = await resolveProject(join(main, logical, nested), logical);
    expect(expected).toMatchObject({ name: "模块 α 👋", relativeRoot: logical.split(sep).join("/"), repository: await realpath(join(main, ".git")) });
    for (const root of [main, mainAlias, external, externalAlias]) {
      for (const explicitRoot of [logical, join(mainAlias, logical), join(externalAlias, logical)]) {
        const mapped = await resolveProject(join(root, logical, nested), explicitRoot);
        expect(mapped).toEqual({ ...expected, root: await realpath(join(root, logical)) });
      }
      expect((await resolveProject(root)).id).toBe((await resolveProject(main)).id);
    }
  }, 30_000);

  test("rejects explicit roots outside membership, in another repository, and missing paths", async () => {
    const base = await temporary();
    const main = await repository(base);
    const other = await repository(base, "other repo");
    await expect(resolveProject(join(main, "apps", "A"), "apps/B")).rejects.toThrow("does not contain cwd");
    await expect(resolveProject(main, join(other, "apps", "A"))).rejects.toThrow("different repository");
    await expect(resolveProject(main, "apps/missing")).rejects.toThrow("explicit project root directory");
    await expect(resolveProject(main, "..")).rejects.toThrow("different repository");
    await expect(resolveProject(main, "")).rejects.toThrow("must not be empty");
    await expect(resolveProject(main, "apps/A/nested/tracked.txt")).rejects.toThrow("Not a directory");
    await expect(resolveProject(join(main, "missing"))).rejects.toThrow("cwd directory");
  }, 20_000);

  test("rejects a logical root that is absent in the current linked worktree", async () => {
    const { main, external } = await worktrees();
    const localOnly = join(main, "local-only");
    await mkdir(localOnly);
    await expect(resolveProject(external, localOnly)).rejects.toThrow("mapped project root directory");
  }, 30_000);

  test("rejects mapped roots whose physical symlink target escapes the current worktree", async () => {
    const base = await temporary();
    const main = await repository(base);
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(main, "escaped"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveProject(main, "escaped")).rejects.toThrow("different repository");
  }, 20_000);

  test("rejects a mapped logical root replaced by a different physical directory", async () => {
    const { main, external } = await worktrees();
    await rm(join(external, "apps", "A"), { recursive: true });
    await symlink(join(external, "apps", "B"), join(external, "apps", "A"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveProject(join(external, "apps", "B"), join(main, "apps", "A"))).rejects.toThrow("does not match logical project path");
  }, 30_000);

  test("reports unexpected Git failures instead of inventing a non-Git identity", async () => {
    const base = await temporary();
    await writeFile(join(base, ".git"), "invalid gitfile format\n");
    await expect(resolveProject(base)).rejects.toThrow("Cannot determine Git repository");
  });
});

describe("non-Git project roots", () => {
  test("defaults to canonical cwd and groups descendants only with an explicit ancestor root", async () => {
    const base = await temporary();
    const parent = join(base, "project");
    const child = join(parent, "child", "nested");
    await mkdir(child, { recursive: true });
    const root = await resolveProject(parent);
    const nested = await resolveProject(child);
    expect(root).toMatchObject({ name: "project", root: await realpath(parent), repository: null, relativeRoot: "." });
    expect(root.id).toMatch(PROJECT_ID_PATTERN);
    expect(nested.id).not.toBe(root.id);
    expect(await resolveProject(child, parent)).toEqual(root);
    expect(await resolveProject(child, "../..")).toEqual(root);
    expect(await resolveProject(child, ".")).toEqual(nested);
  });

  test("resolves non-Git physical aliases and rejects siblings, prefix lookalikes and files", async () => {
    const base = await temporary();
    const parent = join(base, "A");
    const sibling = join(base, "AB");
    const alias = join(base, "alias");
    await mkdir(join(parent, "child"), { recursive: true });
    await mkdir(sibling);
    await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await resolveProject(alias)).toEqual(await resolveProject(parent));
    expect(await resolveProject(join(alias, "child"), alias)).toEqual(await resolveProject(parent));
    await expect(resolveProject(sibling, parent)).rejects.toThrow("does not contain cwd");
    await expect(resolveProject(parent, sibling)).rejects.toThrow("does not contain cwd");
    await writeFile(join(parent, "file"), "not a directory");
    await expect(resolveProject(join(parent, "file"))).rejects.toThrow("Not a directory");
    await expect(resolveProject(parent, "missing")).rejects.toThrow("explicit project root directory");
    await expect(resolveProject("")).rejects.toThrow("must not be empty");
  });
});
