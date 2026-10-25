import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, realpath, rm, writeFile } from "node:fs/promises";
import { expect, onTestFinished } from "vitest";
import { createFirmwareAnalysisProvider } from "../../../src/composition/firmware.js";
import { FirmwareAnalysisService } from "../../../src/application/firmware/FirmwareAnalysisService.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { createTestTempDirectory } from "../temporaryDirectory.js";

/** Exercise real subprocess ownership with synthetic pinned producer representations. */
export const firmwareFixture = async (mode = "normal", banner?: string) => {
  const root = await createTestTempDirectory("rea-firmware-test-");
  const path = join(root, "input.bin");
  await writeFile(path, Buffer.from("fixture-input-data"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const launches: {
    cwd: string | undefined;
    pid: number | undefined;
    args: readonly string[];
  }[] = [];
  let cleanupUnverified = mode === "cleanup-failure";
  const binwalkCommand = await realpath("/usr/bin/true");
  const unblobCommand = await realpath(process.execPath);
  const provider = createFirmwareAnalysisProvider(
    {
      ...process.env,
      REA_BINWALK_COMMAND: binwalkCommand,
      REA_UNBLOB_COMMAND: unblobCommand,
    },
    async (options) => {
      const start = options.arguments.indexOf("--") + 2;
      const args = options.arguments.slice(start);
      const command = options.arguments[start - 1];
      const engine =
        command === binwalkCommand
          ? "binwalk"
          : command === unblobCommand
            ? "unblob"
            : undefined;
      if (engine === undefined)
        throw new Error("Unexpected firmware fixture command");
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        expectedCommand: process.execPath,
        arguments: [
          fileURLToPath(new URL("./producer.mjs", import.meta.url)),
          ...args,
        ],
        env: {
          ...options.env,
          REA_FIRMWARE_FIXTURE_MODE: mode,
          REA_FIRMWARE_FIXTURE_ENGINE: engine,
          ...(banner === undefined
            ? {}
            : { REA_FIRMWARE_FIXTURE_VERSION: banner }),
        },
      });
      launches.push({
        cwd: options.cwd,
        pid: spawned.process.pid,
        args: options.arguments,
      });
      if (mode === "cleanup-failure") {
        return {
          ...spawned,
          cleanup: () =>
            cleanupUnverified
              ? Promise.resolve({
                  cleaned: false,
                  reason: "injected ownership failure",
                })
              : cleanupOwnedProcessGroup(spawned.ownership),
        };
      }
      return spawned;
    },
  );
  const close = async () => {
    if (provider.close === undefined)
      throw new Error("Expected firmware provider cleanup capability");
    await provider.close();
  };
  onTestFinished(async () => {
    cleanupUnverified = false;
    await close();
  });
  return {
    provider,
    service: new FirmwareAnalysisService(provider),
    path,
    output: join(root, "output"),
    root,
    launches,
    close,
    restoreCleanup: () => {
      cleanupUnverified = false;
    },
  };
};

/** Verify only the acquired process groups and private runtime directories. */
export const assertFirmwareCleanup = async (
  launches: Awaited<ReturnType<typeof firmwareFixture>>["launches"],
): Promise<void> => {
  for (const launch of launches) {
    const pid = launch.pid;
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    if (launch.cwd !== undefined)
      await expect(access(launch.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
};
