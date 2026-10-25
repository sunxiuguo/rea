import { beforeEach, expect, it, vi } from "vitest";
import type { FirmwareLauncher } from "../../../src/firmware/FirmwareCommand.js";
import type { OwnedProviderProcessSpawnOptions } from "../../../src/process/ProviderProcess.js";
import { firmwareFixture } from "../../fixtures/firmware/provider.js";

// Exercise the real fixture's dispatch boundary without acquiring a child process.
// The original integration suites separately exercise subprocess ownership.
const state = vi.hoisted(() => ({
  binwalk: "/synthetic/gnutrue",
  node: "/synthetic/canonical-node",
  environment: {} as Readonly<Record<string, string | undefined>>,
  launcher: undefined as FirmwareLauncher | undefined,
  spawn: vi.fn<(options: OwnedProviderProcessSpawnOptions) => Promise<never>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    realpath: async (path: string) => {
      if (path === "/usr/bin/true") return state.binwalk;
      if (path === process.execPath) return state.node;
      return filesystem.realpath(path);
    },
  };
});

vi.mock("../../../src/composition/firmware.js", () => ({
  createFirmwareAnalysisProvider: (
    environment: Readonly<Record<string, string | undefined>>,
    launcher: FirmwareLauncher,
  ) => {
    state.environment = environment;
    state.launcher = launcher;
    return { close: async () => {} };
  },
}));

vi.mock("../../../src/process/ProviderProcess.js", () => ({
  spawnOwnedProviderProcess: state.spawn,
}));

beforeEach(() => {
  state.binwalk = "/synthetic/gnutrue";
  state.node = "/synthetic/canonical-node";
  state.environment = {};
  state.launcher = undefined;
  state.spawn.mockReset();
});

const launch = (command: string | undefined) => {
  if (state.launcher === undefined) throw new Error("Fixture launcher missing");
  return state.launcher({
    command: process.execPath,
    arguments: command === undefined ? ["--"] : ["--", command, "--version"],
    runId: "synthetic-firmware-identity",
  });
};

it.each(["/synthetic/true", "/synthetic/gnutrue"])(
  "routes canonical binwalk identity %s without interpreting its basename",
  async (canonicalCommand) => {
    state.binwalk = canonicalCommand;
    const stopped = new Error("Synthetic spawn boundary reached");
    state.spawn.mockRejectedValue(stopped);
    await firmwareFixture();
    expect(state.environment.REA_BINWALK_COMMAND).toBe(canonicalCommand);
    expect(state.environment.REA_UNBLOB_COMMAND).toBe(state.node);
    await expect(launch(canonicalCommand)).rejects.toBe(stopped);
    expect(state.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        env: expect.objectContaining({ REA_FIRMWARE_FIXTURE_ENGINE: "binwalk" }),
      }),
    );
  },
);

it("routes the canonical Node identity to unblob", async () => {
  const stopped = new Error("Synthetic spawn boundary reached");
  state.spawn.mockRejectedValue(stopped);
  await firmwareFixture();
  await expect(launch(state.node)).rejects.toBe(stopped);
  expect(state.spawn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      env: expect.objectContaining({ REA_FIRMWARE_FIXTURE_ENGINE: "unblob" }),
    }),
  );
});

it.each(["/unrelated/true", "/unrelated/node", undefined])(
  "rejects unconfigured or missing command %s before spawning",
  async (command) => {
    await firmwareFixture();
    await expect(launch(command)).rejects.toThrow(
      "Unexpected firmware fixture command",
    );
    expect(state.spawn).not.toHaveBeenCalled();
  },
);
