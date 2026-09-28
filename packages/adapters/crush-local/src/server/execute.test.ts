import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runChildProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => {}),
    resolveCommandForLogs: vi.fn(async () => "crush"),
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";

const roots: string[] = [];

async function context(overrides: Partial<AdapterExecutionContext> = {}): Promise<AdapterExecutionContext> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-crush-test-"));
  roots.push(cwd);
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Crush Agent",
      adapterType: "crush_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd, model: "nvidia/example-model" },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  };
}

const success = (stdout: string) => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });

describe("crush_local execute", () => {
  beforeEach(() => runChildProcessMock.mockReset());
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs headlessly and saves only this agent's session", async () => {
    const ctx = await context({
      runtimeTools: {
        version: 1,
        guidance: "Use the runtime tools",
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "tool-token",
        expiresAt: "2026-09-29T00:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      },
    });
    runChildProcessMock
      .mockResolvedValueOnce(success("Probe completed"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "session-1" } })));

    const result = await execute(ctx);
    const [runId, command, args, options] = runChildProcessMock.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(command).toBe("crush");
    expect(args.slice(0, 2)).toEqual(["run", "--quiet"]);
    expect(args).toContain("--cwd");
    expect(args).toContain("--data-dir");
    expect(args).toContain("nvidia/example-model");
    expect(options.env.PAPERCLIP_API_KEY).toBe("run-token");
    expect(options.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("tool-token");
    const dataDir = args[args.indexOf("--data-dir") + 1];
    expect(dataDir).toContain(path.join("company-1", "agent-1"));
    expect(runChildProcessMock.mock.calls[1][2]).toEqual([
      "session", "last", "--json", "--cwd", ctx.config.cwd, "--data-dir", dataDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "session-1", summary: "Probe completed" });
  });

  it("rejects a remote execution target before launching a local process", async () => {
    const ctx = await context({
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
      },
    });
    await expect(execute(ctx)).rejects.toThrow("supports local execution only");
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  it("retries without a saved session when Crush reports it missing", async () => {
    const ctx = await context({
      runtime: {
        sessionId: "old-session",
        sessionParams: { sessionId: "old-session" },
        sessionDisplayId: "old-session",
        taskKey: null,
      },
    });
    runChildProcessMock
      .mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "session not found" })
      .mockResolvedValueOnce(success("Recovered"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "new-session" } })));

    const result = await execute(ctx);
    expect(runChildProcessMock.mock.calls[0][2]).toContain("old-session");
    expect(runChildProcessMock.mock.calls[1][2]).not.toContain("old-session");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "new-session", summary: "Recovered" });
  });

  it("reports a provider failure even when Crush exits with code zero", async () => {
    const ctx = await context();
    runChildProcessMock
      .mockResolvedValueOnce(success("Agent processing failed: Service temporarily overloaded."))
      .mockResolvedValueOnce(success(JSON.stringify({
        meta: { id: "failed-session" },
        messages: [{ role: "assistant", parts: [{ type: "finish", reason: "error" }] }],
      })));

    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Service temporarily overloaded");
    expect(result.sessionId).toBeNull();
    expect(result.clearSession).toBe(true);
  });

  it("reports a provider failure when Crush cannot save a session", async () => {
    const ctx = await context();
    runChildProcessMock
      .mockResolvedValueOnce(success("Agent processing failed: provider unavailable"))
      .mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "session not found" });

    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, clearSession: true });
  });
});
