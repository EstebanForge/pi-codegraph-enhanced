import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockProcess()),
}));

function createMockProcess(returnResult?: { content?: any[]; isError?: boolean }) {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
  });

  child.stdin.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
      if (msg.method === "tools/call") {
        const result = returnResult ?? { content: [{ type: "text", text: `called ${msg.params.name}` }] };
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result,
        }) + "\n");
      }
    }
  });

  return child;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pi-codegraph extension", () => {
  it("exports all CodeGraph tool names", async () => {
    const mod = await import("../extensions/codegraph.js");

    expect(mod.codegraphToolNames).not.toContain("codegraph_context");
    expect(mod.codegraphToolNames).not.toContain("codegraph_trace");
    expect(mod.codegraphToolNames).toHaveLength(8);
  });

  it("proxies tool calls through CodeGraph MCP", async () => {
    const { callCodeGraphTool } = await import("../extensions/codegraph.js");

    await expect(callCodeGraphTool("codegraph_status", {})).resolves.toBe("called codegraph_status");
  });

  it("uses the direct codegraph executable outside Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp } = await import("../extensions/codegraph.js");

    await withCodeGraphMcp(process.cwd(), undefined, async () => "success");

    expect(spawn).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", process.cwd()], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("uses PowerShell command discovery for the CodeGraph executable on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp } = await import("../extensions/codegraph.js");

    await withCodeGraphMcp(process.cwd(), undefined, async () => "success");

    const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
    const spawnArgs = args as string[];
    const script = spawnArgs[spawnArgs.indexOf("-Command") + 1];

    expect(command).toBe("powershell.exe");
    expect(spawnArgs).toEqual(expect.arrayContaining([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]));
    expect(script).toContain("Get-Command codegraph");
    expect(script).toContain("-CommandType Application");
    expect(script).toContain("Select-Object -First 1");
    // The codegraph invocation is now baked into the script as quoted tokens,
    // with serve/--mcp/--path and the project path all present.
    expect(script).toContain("'serve'");
    expect(script).toContain("'--mcp'");
    expect(script).toContain("'--path'");
    expect(script).toContain(process.cwd());
    expect(script).not.toContain("codegraph.cmd");
    expect(script).not.toMatch(/Users[\\/]cq/i);
    expect(script).not.toMatch(/scoop/i);
    expect(options).toEqual({
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("validates projectPath before starting CodeGraph", async () => {
    const { resolveProjectCwd } = await import("../extensions/codegraph.js");

    await expect(resolveProjectCwd("relative/project")).rejects.toThrow("absolute path");
    await expect(resolveProjectCwd("/path/that/does/not/exist")).rejects.toThrow("does not exist");
    await expect(resolveProjectCwd(fileURLToPath(import.meta.url))).rejects.toThrow("directory");
  });

  it("preserves Unix paths on macOS/Linux", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });

    const { resolveProjectCwd } = await import("../extensions/codegraph.js");
    const cwd = await resolveProjectCwd(process.cwd());
    expect(cwd).toBe(process.cwd());
  });

  it("normalizes WSL and Git Bash paths on Windows", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });

    const { normalizeWindowsPath } = await import("../extensions/codegraph.js");

    expect(normalizeWindowsPath("/mnt/c/Users/dev/project")).toBe("C:\\Users\\dev\\project");
    expect(normalizeWindowsPath("/c/Users/dev/project")).toBe("C:\\Users\\dev\\project");
    expect(normalizeWindowsPath("/Users/vndv/project")).toBe("/Users/vndv/project");
  });

  it("redacts sensitive stderr diagnostics", async () => {
    const { sanitizeDiagnostic } = await import("../extensions/codegraph.js");

    const diagnostic = sanitizeDiagnostic(
      "\u001b[31mfailed TOKEN=abc123 Bearer secret-token --otp 123456 --api-key=hidden\u001b[0m",
    );

    expect(diagnostic).toContain("TOKEN=[redacted]");
    expect(diagnostic).toContain("Bearer [redacted]");
    expect(diagnostic).toContain("--[redacted]");
    expect(diagnostic).not.toContain("abc123");
    expect(diagnostic).not.toContain("secret-token");
    expect(diagnostic).not.toContain("123456");
    expect(diagnostic).not.toContain("hidden");
  });

  describe("normalizeFilesPath", () => {
    it("returns undefined for empty/undefined input", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath()).toBeUndefined();
      expect(normalizeFilesPath("")).toBeUndefined();
    });

    it("expands ~ to the home directory", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");
      vi.spyOn(os, "homedir").mockReturnValue("/home/user");

      expect(normalizeFilesPath("~/project/src/components", "/home/user/project")).toBe("src/components");
      expect(normalizeFilesPath("~/project", "/home/user/project")).toBeUndefined();
    });

    it("converts an absolute path inside the project to a repo-relative POSIX prefix", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath(path.join(process.cwd(), "src/components"), process.cwd())).toBe("src/components");
    });

    it("drops the filter when the path equals the project root", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath(process.cwd(), process.cwd())).toBeUndefined();
    });

    it("leaves relative inputs and out-of-project absolute paths untouched", async () => {
      const { normalizeFilesPath } = await import("../extensions/codegraph.js");

      expect(normalizeFilesPath("components", "/project")).toBe("components");
      expect(normalizeFilesPath("/outside/project", "/project")).toBe("/outside/project");
    });
  });

  describe("annotateFilesResult", () => {
    it("appends a hint to the bare empty marker when a path filter was supplied", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      const result = annotateFilesResult("No files found matching the criteria.", "components");
      expect(result).toContain("Hint:");
      expect(result).toContain("root-relative POSIX prefix");
      expect(result).toContain('"components"');
    });

    it("returns non-empty text unchanged", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      expect(annotateFilesResult("src/Button.ts", "components")).toBe("src/Button.ts");
    });

    it("returns the empty marker unchanged when no path filter was supplied", async () => {
      const { annotateFilesResult } = await import("../extensions/codegraph.js");

      expect(annotateFilesResult("No files found matching the criteria.")).toBe(
        "No files found matching the criteria.",
      );
    });
  });

  it("clears the timeout timer on successful session completion", async () => {
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp } = await import("../extensions/codegraph.js");

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => { child.killed = true; });

      child.stdin.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          }
        }
      });

      return child;
    });

    await withCodeGraphMcp(process.cwd(), undefined, async () => "success");

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("clears the timeout timer on abort signal", async () => {
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp } = await import("../extensions/codegraph.js");

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => { child.killed = true; });

      child.stdin.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          }
        }
      });

      return child;
    });

    const controller = new AbortController();
    const promise = withCodeGraphMcp(process.cwd(), controller.signal, async (request) => {
      const toolPromise = request("tools/call", {});
      controller.abort();
      return toolPromise;
    });

    await expect(promise).rejects.toThrow("CodeGraph MCP process closed before responding.");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("times out when the MCP session never completes", async () => {
    const { spawn } = await import("node:child_process");
    const { withCodeGraphMcp, SessionTimeoutMs } = await import("../extensions/codegraph.js");

    const killMock = vi.fn(() => {});
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = killMock;
      return child;
    });

    const promise = withCodeGraphMcp(process.cwd(), undefined, async () => "done");

    await expect(promise).rejects.toThrow("CodeGraph MCP session timed out after " + SessionTimeoutMs);
    expect(killMock).toHaveBeenCalled();
  }, 22000);

  it("normalizes codegraph_files path before forwarding to the MCP server", async () => {
    const { spawn } = await import("node:child_process");
    const { callCodeGraphTool } = await import("../extensions/codegraph.js");
    let capturedArgs: Record<string, unknown> | undefined;

    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => { child.killed = true; });

      child.stdin.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf-8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
          }
          if (msg.method === "tools/call") {
            capturedArgs = msg.params.arguments;
            child.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { content: [{ type: "text", text: "src/Button.ts" }] },
            }) + "\n");
          }
        }
      });

      return child;
    });

    await callCodeGraphTool("codegraph_files", {
      projectPath: process.cwd(),
      path: path.join(process.cwd(), "src"),
    });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.path).toBe("src");
  });
});

describe("ensureCodeGraphIndex", () => {
  let tmpDir: string;
  let calls: { args: string[]; cwd: string }[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-ensure-"));
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeRunner(
    responses: Record<string, { stdout?: string; stderr?: string; code?: number }>,
  ) {
    return async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      const key = args.join(" ");
      // Default: codegraph is installed and responsive.
      const resp = responses[key] ?? { code: 0 };
      return {
        stdout: resp.stdout ?? "",
        stderr: resp.stderr ?? "",
        code: resp.code ?? 0,
        timedOut: false,
      };
    };
  }

  it("returns unavailable and runs no further commands when codegraph is missing", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    const runner = makeRunner({
      "--version": { stderr: "spawn codegraph ENOENT", code: -1 },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("unavailable");
    expect(calls.map((c) => c.args)).toEqual([["--version"]]);
  });

  it("returns unavailable instead of a false initialized when init exits non-zero", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    const runner = makeRunner({
      "init -i": { stderr: "disk full", code: 1 },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("unavailable");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["init", "-i"]]);
  });

  it("runs `init -i` when .codegraph/ is missing", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    const runner = makeRunner({});

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("initialized");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["init", "-i"]]);
  });

  it("runs `index -f` when status reports initialized=false (uninitialized .codegraph/)", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": { stdout: JSON.stringify({ initialized: false }) },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("rebuilt");
    expect(calls.map((c) => c.args)).toEqual([
      ["--version"],
      ["status", "--json"],
      ["index", "-f", "-q"],
    ]);
  });

  it("runs `index -f` when status exits non-zero (corrupt/unreadable DB)", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": { stderr: "database disk image is malformed", code: 1 },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("rebuilt");
    expect(calls.map((c) => c.args)).toEqual([
      ["--version"],
      ["status", "--json"],
      ["index", "-f", "-q"],
    ]);
  });

  it("runs `index -f` when status stdout is unparseable", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": { stdout: "not json at all" },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("rebuilt");
  });

  it("runs `sync` when pendingChanges > 0 (drift detected)", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": {
        stdout: JSON.stringify({
          initialized: true,
          pendingChanges: { added: 2, modified: 1, removed: 0 },
        }),
      },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("synced");
    expect(calls.map((c) => c.args)).toEqual([
      ["--version"],
      ["status", "--json"],
      ["sync", "-q"],
    ]);
  });

  it("is a no-op when the index is present and clean", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": {
        stdout: JSON.stringify({
          initialized: true,
          pendingChanges: { added: 0, modified: 0, removed: 0 },
        }),
      },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("skipped");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["status", "--json"]]);
  });

  it("propagates runner exceptions so the caller (the hook) decides to swallow them", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const throwingRunner = async () => {
      throw new Error("codegraph binary exploded");
    };

    await expect(ensureCodeGraphIndex(tmpDir, throwingRunner)).rejects.toThrow("exploded");
  });

  it("returns busy when a command reports a file-lock conflict (another process owns the index)", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": {
        stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 3, modified: 0, removed: 0 } }),
      },
      "sync -q": { stderr: "Error: Could not acquire file lock - another process may be indexing", code: 1 },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("busy");
  });

  it("returns busy (not rebuilt) when status itself is lock-busy", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = makeRunner({
      "status --json": { stderr: "Could not acquire file lock", code: 1 },
    });

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    // Must NOT escalate to a forced reindex — that would race the lock holder.
    expect(result.action).toBe("busy");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["status", "--json"]]);
  });

  it("returns busy when status times out, instead of escalating to a full reindex", async () => {
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    // A runner whose status call resolves with timedOut:true (as the real runner
    // does once runWithTimeout aborts it). Proves a slow status is NOT treated as
    // corruption (which would trigger an expensive `index -f`).
    const runner = async (args: string[]) => {
      calls.push({ args, cwd: tmpDir });
      if (args[0] === "--version") return { stdout: "1", stderr: "", code: 0, timedOut: false };
      return { stdout: "", stderr: "", code: -1, timedOut: true };
    };

    const result = await ensureCodeGraphIndex(tmpDir, runner);

    expect(result.action).toBe("busy");
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["status", "--json"]]);
  });

  it("ensureCodeGraphIndexOnce collapses overlapping calls into one", async () => {
    const { ensureCodeGraphIndexOnce } = await import("../extensions/codegraph.js");
    const pending: Array<(v: any) => void> = [];
    const runner = async (args: string[]) => {
      calls.push({ args, cwd: tmpDir });
      if (args[0] === "init") {
        return new Promise((resolve) => {
          pending.push(resolve);
        }) as any;
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const a = ensureCodeGraphIndexOnce(tmpDir, runner as any);
    const b = ensureCodeGraphIndexOnce(tmpDir, runner as any);

    expect(a).toBe(b); // same in-flight promise
    // Let the awaited --version probe (and the real stat() on the threadpool)
    // settle so the init call materializes. vi.waitFor avoids the setTimeout(0)
    // race against libuv's poll phase.
    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === "init")).toBe(true));
    expect(calls.filter((c) => c.args[0] === "init").length).toBe(1);

    for (const r of pending) r({ stdout: "", stderr: "", code: 0, timedOut: false });
    await expect(a).resolves.toEqual({ action: "initialized", projectPath: tmpDir });
  });
});

describe("defaultCodeGraphRunner (real spawn path)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("kills the child and resolves timedOut:true when the signal aborts", async () => {
    const { spawn } = await import("node:child_process");
    const { defaultCodeGraphRunner } = await import("../extensions/codegraph.js");

    let killCalls = 0;
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      // kill() simulates SIGTERM: marks killed and emits exit so the runner resolves.
      child.kill = vi.fn(() => {
        child.killed = true;
        killCalls++;
        child.emit("exit", null);
      });
      return child;
    });

    const ac = new AbortController();
    const promise = defaultCodeGraphRunner(["index", "-f", "-q"], process.cwd(), ac.signal);
    ac.abort();
    const result = await promise;

    expect(killCalls).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(-1);
  });

  it("resolves timedOut:false and the real exit code on normal completion", async () => {
    const { spawn } = await import("node:child_process");
    const { defaultCodeGraphRunner } = await import("../extensions/codegraph.js");

    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn();
      // Emit stderr + exit AFTER the runner has attached its data listeners
      // (next tick), so the chunk is actually captured.
      queueMicrotask(() => {
        child.stderr.write("Could not acquire file lock");
        child.emit("exit", 1);
      });
      return child;
    });

    const ac = new AbortController();
    const result = await defaultCodeGraphRunner(["status", "--json"], process.cwd(), ac.signal);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("file lock");
    expect(ac.signal.aborted).toBe(false);
  });

  it("runWithTimeout aborts a hanging spawn via the real runner (driven by the module timer)", async () => {
    vi.useFakeTimers();
    const { VersionProbeTimeoutMs } = await import("../extensions/codegraph.js");
    const { spawn } = await import("node:child_process");

    let killCalled = false;
    // Every spawn returns a child that NEVER exits on its own — only kill() does.
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn(() => {
        child.killed = true;
        killCalled = true;
        child.emit("exit", null);
      });
      return child;
    });

    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-timeout-"));
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    try {
      const promise = ensureCodeGraphIndex(tmpDir);
      // The --version probe hangs first; advance past its short timeout to abort it.
      await vi.advanceTimersByTimeAsync(VersionProbeTimeoutMs);
      const result = await promise;

      // Probe timed out → unavailable; and the hanging child was killed.
      expect(result.action).toBe("unavailable");
      expect(killCalled).toBe(true);
    } finally {
      vi.useRealTimers();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});


describe("stale-lock recovery (index -f reclaims stale locks)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-lockfix-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rebuilds (not busy) when status fails with a stale lock present", async () => {
    // Regression guard: an earlier revision checked for a `.lock` file and
    // returned `busy`, which blocked recovery — codegraph `index -f` reclaims
    // stale locks (verified empirically), so a corrupt DB must be rebuilt even
    // when a crash-leftover lock file is sitting in .codegraph/.
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    await fs.writeFile(path.join(tmpDir, ".codegraph", "codegraph.lock"), "");
    const runner = async (args: string[]) => {
      if (args[0] === "--version") return { stdout: "1", stderr: "", code: 0, timedOut: false };
      if (args[0] === "status") return { stdout: "", stderr: "malformed", code: 1, timedOut: false };
      // index -f reclaims the stale lock and succeeds.
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };

    const result = await ensureCodeGraphIndex(tmpDir, runner as any);

    expect(result.action).toBe("rebuilt");
  });

  it("still returns busy when index -f reports a LIVE lock conflict", async () => {
    // A genuinely held lock (another active process) surfaces in stderr and is
    // caught by looksLikeLockFailure — this is the real contention case.
    const { ensureCodeGraphIndex } = await import("../extensions/codegraph.js");
    await fs.mkdir(path.join(tmpDir, ".codegraph"));
    const runner = async (args: string[]) => {
      if (args[0] === "--version") return { stdout: "1", stderr: "", code: 0, timedOut: false };
      if (args[0] === "status") return { stdout: "", stderr: "malformed", code: 1, timedOut: false };
      return { stdout: "", stderr: "Could not acquire file lock", code: 1, timedOut: false };
    };

    const result = await ensureCodeGraphIndex(tmpDir, runner as any);

    expect(result.action).toBe("busy");
  });
});

describe("/codegraph flag + status", () => {
  function fakePi(flagValue: boolean | undefined): any {
    return {
      getFlag: () => flagValue,
    };
  }

  it("exports the single auto-index flag name", async () => {
    const { codegraphFlagNames } = await import("../extensions/codegraph.js");
    expect(codegraphFlagNames).toEqual(["codegraph-auto-index"]);
  });

  it("renders the status panel with the flag checked when on (default)", async () => {
    const { renderCodeGraphStatus, setLastStartupActionForTest } = await import("../extensions/codegraph.js");
    setLastStartupActionForTest({ action: "synced", projectPath: "/p" });

    const panel = renderCodeGraphStatus(fakePi(true));

    expect(panel).toContain("[x] codegraph-auto-index");
    expect(panel).toContain("last startup action: synced");
    expect(panel).toContain("/codegraph toggle");
  });

  it("renders the flag unchecked when explicitly disabled", async () => {
    const { renderCodeGraphStatus } = await import("../extensions/codegraph.js");
    const panel = renderCodeGraphStatus(fakePi(false));
    expect(panel).toContain("[ ] codegraph-auto-index");
  });

  it("reports no startup action yet when none has run this session", async () => {
    const { renderCodeGraphStatus, setLastStartupActionForTest } = await import("../extensions/codegraph.js");
    setLastStartupActionForTest(undefined);
    const panel = renderCodeGraphStatus(fakePi(true));
    expect(panel).toContain("(none yet this session)");
  });
});

describe("auto-index flag gating in resources_discover", () => {
  // Drives the real resources_discover handler via a fake pi. Returns whether
  // the codegraph CLI got spawned (i.e. the gate proceeded past its checks).
  async function driveGate(opts: { flag: boolean | undefined; indexed: boolean }): Promise<boolean> {
    const mod = await import("../extensions/codegraph.js");
    let spawned = false;
    const handlers: Record<string, (e: any, ctx: any) => void> = {};
    const fakePi = {
      registerFlag: () => {},
      registerCommand: () => {},
      registerTool: () => {},
      getFlag: () => opts.flag,
      on: (ev: string, fn: any) => {
        handlers[ev] = fn;
      },
    } as any;

    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockImplementation(() => {
      spawned = true;
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = vi.fn();
      return child;
    });

    (mod.default as any)(fakePi);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cg-gate-"));
    try {
      if (opts.indexed) await fs.mkdir(path.join(tmp, ".codegraph"));
      await handlers["resources_discover"]({ cwd: tmp, reason: "startup" }, { hasUI: false });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    return spawned;
  }

  it("skips the gate when flag is off and no .codegraph/ exists", async () => {
    expect(await driveGate({ flag: false, indexed: false })).toBe(false);
  });

  it("still runs the gate (maintenance) when flag is off but .codegraph/ already exists", async () => {
    // Existing indexes are always kept fresh, regardless of the flag.
    expect(await driveGate({ flag: false, indexed: true })).toBe(true);
  });

  it("runs the gate when the flag is on, even with no existing index", async () => {
    expect(await driveGate({ flag: true, indexed: false })).toBe(true);
  });
});
