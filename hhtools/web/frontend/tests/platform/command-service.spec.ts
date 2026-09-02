import { describe, expect, it, vi } from "vitest";

import {
  CommandNotFoundError,
  CommandService,
} from "../../src/platform/commands/common/command-service";

describe("CommandService", () => {
  it("executes a registered command with arguments and a result", async () => {
    const service = new CommandService();
    const handler = vi.fn((left: number, right: number) => left + right);
    service.registerCommand("math.add", handler);

    await expect(
      service.executeCommand<number>("math.add", 2, 3),
    ).resolves.toBe(5);
    expect(handler).toHaveBeenCalledWith(2, 3);
  });

  it("gives each command exactly one owner", () => {
    const service = new CommandService();
    service.registerCommand("video.pick", () => undefined);

    expect(() =>
      service.registerCommand("video.pick", () => undefined),
    ).toThrow("Command is already registered: video.pick");
  });

  it("unregisters idempotently without removing a later owner", async () => {
    const service = new CommandService();
    const first = service.registerCommand("video.pick", () => "first");
    first.dispose();
    const second = service.registerCommand("video.pick", () => "second");
    first.dispose();

    await expect(
      service.executeCommand<string>("video.pick"),
    ).resolves.toBe("second");
    second.dispose();
    await expect(service.executeCommand("video.pick")).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
  });

  it("preserves handler failures for the caller", async () => {
    const service = new CommandService();
    const failure = new Error("picker failed");
    service.registerCommand("video.pick", async () => {
      throw failure;
    });

    await expect(service.executeCommand("video.pick")).rejects.toBe(failure);
  });

  it("clears registrations and rejects later use when disposed", async () => {
    const service = new CommandService();
    service.registerCommand("video.pick", () => undefined);
    service.dispose();
    service.dispose();

    await expect(service.executeCommand("video.pick")).rejects.toThrow(
      "Command service is disposed",
    );
    expect(() =>
      service.registerCommand("video.pick", () => undefined),
    ).toThrow("Command service is disposed");
  });
});
