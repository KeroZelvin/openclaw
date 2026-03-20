import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attachChildProcessBridgeMock = vi.hoisted(() => vi.fn());
const installProcessWarningFilterMock = vi.hoisted(() => vi.fn());
const isMainModuleMock = vi.hoisted(() => vi.fn(() => true));
const isRootHelpInvocationMock = vi.hoisted(() => vi.fn(() => false));
const isRootVersionInvocationMock = vi.hoisted(() => vi.fn(() => false));
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const normalizeWindowsArgvMock = vi.hoisted(() => vi.fn((argv: string[]) => argv));
const parseCliProfileArgsMock = vi.hoisted(() => vi.fn((argv: string[]) => ({ ok: true, argv })));
const runCliMock = vi.hoisted(() => vi.fn(async () => {}));
const shouldSkipRespawnForArgvMock = vi.hoisted(() => vi.fn(() => false));
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./cli/argv.js", () => ({
  isRootHelpInvocation: isRootHelpInvocationMock,
  isRootVersionInvocation: isRootVersionInvocationMock,
}));

vi.mock("./cli/profile.js", () => ({
  applyCliProfileEnv: vi.fn(),
  parseCliProfileArgs: parseCliProfileArgsMock,
}));

vi.mock("./cli/respawn-policy.js", () => ({
  shouldSkipRespawnForArgv: shouldSkipRespawnForArgvMock,
}));

vi.mock("./cli/run-main.js", () => ({
  runCli: runCliMock,
}));

vi.mock("./cli/windows-argv.js", () => ({
  normalizeWindowsArgv: normalizeWindowsArgvMock,
}));

vi.mock("./infra/env.js", () => ({
  isTruthyEnvValue: (value: string | undefined) =>
    typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()),
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("./infra/is-main.js", () => ({
  isMainModule: isMainModuleMock,
}));

vi.mock("./infra/warning-filter.js", () => ({
  installProcessWarningFilter: installProcessWarningFilterMock,
}));

vi.mock("./process/child-process-bridge.js", () => ({
  attachChildProcessBridge: attachChildProcessBridgeMock,
}));

describe("entry supervised startup", () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
    process.argv = ["node", "openclaw", "gateway", "run"];
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    delete process.env.OPENCLAW_NO_RESPAWN;
    delete process.env.OPENCLAW_NODE_OPTIONS_READY;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it("skips the warning-suppression respawn under systemd and runs the CLI inline", async () => {
    await import("./entry.js");

    await vi.waitFor(() => {
      expect(runCliMock).toHaveBeenCalledWith(process.argv);
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(attachChildProcessBridgeMock).not.toHaveBeenCalled();
  });
});
