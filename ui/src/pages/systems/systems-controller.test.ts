/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SystemsController } from "./systems-controller.ts";

const environment: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway",
  status: "available",
};
const runtimeConfigs: ReturnType<typeof createRuntimeConfigCapability>[] = [];

afterEach(() => {
  for (const runtimeConfig of runtimeConfigs.splice(0)) {
    runtimeConfig.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(inventory: () => Promise<EnvironmentSummary[]> = async () => [environment]) {
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "environments.list") {
      return { environments: await inventory() };
    }
    if (method === "system.info") {
      return {};
    }
    if (method === "node.list") {
      return { nodes: [] };
    }
    if (method === "backup.status") {
      return { targets: [], schedules: [], locations: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(
      ["environments.list", "node.list", "system.info"],
      ["operator.admin"],
    ),
  });
  const sessionsHarness = createSessionsHarness("main", []);
  const context = createContext(gateway.gateway, sessionsHarness.sessions);
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  runtimeConfigs.push(runtimeConfig);
  Object.assign(context, { runtimeConfig });
  const controller = new SystemsController(context);
  controller.setPresented(true);
  return { controller, gateway, request, sessionsHarness };
}

async function ready(controller: SystemsController) {
  await vi.waitFor(() => expect(controller.inventory).not.toBeNull());
}

function placementRow(generation: number): GatewaySessionRow {
  return {
    key: "agent:main:worker",
    sessionId: "worker",
    kind: "direct",
    updatedAt: generation,
    placement: {
      state: "reclaimed",
      generation,
      createdAtMs: 1,
      updatedAtMs: generation,
      stateChangedAtMs: generation,
      environmentId: "worker-one",
      activeOwnerEpoch: 1,
    },
  };
}

function publishPlacement(
  sessionsHarness: ReturnType<typeof createSessionsHarness>,
  generation: number,
) {
  sessionsHarness.publish({
    result: {
      ts: generation,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [placementRow(generation)],
    },
  });
}

it("paces worker placement invalidations and ignores unrelated session changes", async () => {
  const { controller, gateway, request } = harness();
  await ready(controller);

  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const inventoryReads = () =>
    request.mock.calls.filter(([method]) => method === "environments.list");
  gateway.publishEvent("sessions.changed", { reason: "activity-summary" });
  gateway.publishEvent("sessions.changed", { reason: "placement" });
  gateway.publishEvent("sessions.changed", { reason: "reclaim" });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(2);

  controller.setPresented(false);
});

it("coalesces placement snapshots and retains one trailing refresh during an inventory read", async () => {
  let inventory = async () => [environment];
  const { controller, request, sessionsHarness } = harness(() => inventory());
  await ready(controller);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const inventoryReads = () =>
    request.mock.calls.filter(([method]) => method === "environments.list");

  publishPlacement(sessionsHarness, 1);
  publishPlacement(sessionsHarness, 2);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(2);

  const pending = createDeferred<EnvironmentSummary[]>();
  inventory = () => pending.promise;
  publishPlacement(sessionsHarness, 3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(inventoryReads()).toHaveLength(3);
  publishPlacement(sessionsHarness, 4);
  inventory = async () => [environment];
  pending.resolve([environment]);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(4);

  controller.setPresented(false);
});

function finishedWorker(
  id: string,
  ended: number,
  state: "destroyed" | "failed" | "ready" = "destroyed",
): EnvironmentSummary {
  return {
    id,
    type: "worker",
    label: id,
    status: "unavailable",
    worker: {
      providerId: "test",
      state,
      ageMs: 0,
      stateChangedAtMs: ended,
      createdAtMs: ended - 1000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

it("expires finished history without telemetry, preserves detail and pending cleanup, and stops its timer on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const expired = finishedWorker("expired", Date.now() - 15 * 60_000 + 1);
  const active = finishedWorker("active", 0, "ready");
  const pending = finishedWorker("pending", 0, "failed");
  pending.worker!.cleanupPending = true;
  const { controller } = harness(async () => [expired, active, pending]);
  await ready(controller);
  controller.showStats = false;
  controller.select("expired");
  const listener = vi.fn();
  controller.subscribe(listener);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(listener).toHaveBeenCalled();
  expect(controller.visibleRows.map((row) => row.environment.id)).toEqual(["active", "pending"]);
  expect(controller.selected?.environment.id).toBe("expired");
  controller.toggleWorkerHistory();
  expect(controller.visibleRows).toHaveLength(3);
  controller.setPresented(false);
  listener.mockClear();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(listener).not.toHaveBeenCalled();
});

it("syncs dismissal and names through preferences, preserves rows on write failure, and isolates profile changes", async () => {
  const worker = finishedWorker("worker:one", Date.now());
  const { controller, gateway, request } = harness(async () => [worker]);
  await ready(controller);
  let prefs: Record<string, unknown> = {};
  let fail = false;
  request.mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: structuredClone(prefs) };
    }
    if (method === "users.prefs.set") {
      if (fail) {
        throw new Error("write refused");
      }
      const params = args[0] as { entries: Record<string, unknown> };
      prefs = { ...prefs, ...params.entries };
      return { status: "ok" };
    }
    throw new Error(method);
  });
  gateway.publish({
    selfUser: { id: "alice" } as NonNullable<typeof gateway.gateway.snapshot.selfUser>,
  });
  await vi.waitFor(() =>
    expect(request.mock.calls.some(([method]) => method === "users.prefs.get")).toBe(true),
  );
  fail = true;
  await controller.dismissWorker(worker.id);
  expect(controller.workerHistoryError).toBe("write refused");
  expect(controller.visibleRows).toHaveLength(1);
  fail = false;
  await controller.renameWorker(worker.id, "CAD coupon");
  expect(controller.workerName(worker.id)).toBe("CAD coupon");
  await controller.dismissWorker(worker.id);
  expect(controller.visibleRows).toHaveLength(0);
  expect(controller.rows).toHaveLength(1);
  prefs = { "ui.workerHistory.retentionMinutes": 30 };
  gateway.publishEvent("users.prefs.changed", {
    profileId: "alice-canonical",
    keys: ["ui.workerHistory.entries"],
  });
  await vi.waitFor(() => expect(controller.historyRetentionMinutes).toBe(30));
  expect(controller.visibleRows).toHaveLength(1);
  gateway.publish({ selfUser: null });
  expect(controller.canEditWorkerPreferences).toBe(false);
  expect(controller.workerName(worker.id)).toBeUndefined();
  expect(controller.historyRetentionMinutes).toBe(15);
  controller.setPresented(false);
});

it("merges a concurrent preference writer after CAS conflict and discards a retired profile response", async () => {
  const worker = finishedWorker("worker:one", Date.now());
  const other = finishedWorker("worker:two", Date.now());
  const { controller, gateway, request } = harness(async () => [worker, other]);
  await ready(controller);
  let prefs: Record<string, unknown> = {};
  let writes = 0;
  const late = createDeferred<{ status: "ok" }>();
  let hold = false;
  request.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: structuredClone(prefs) };
    }
    if (method === "users.prefs.set") {
      writes += 1;
      if (hold) {
        return late.promise;
      }
      if (writes === 1) {
        prefs = {
          "ui.workerHistory.entries": {
            [other.id]: { updatedAtMs: Date.now(), name: "Other client's CAD" },
          },
        };
        return { status: "conflict" };
      }
      prefs = { ...prefs, ...(params as { entries: Record<string, unknown> }).entries };
      return { status: "ok" };
    }
    throw new Error(method);
  });
  gateway.publish({
    selfUser: { id: "alice" } as NonNullable<typeof gateway.gateway.snapshot.selfUser>,
  });
  await controller.renameWorker(worker.id, "My CAD");
  expect(writes).toBe(2);
  expect(controller.workerName(other.id)).toBe("Other client's CAD");
  expect(controller.workerName(worker.id)).toBe("My CAD");
  hold = true;
  const pending = controller.renameWorker(worker.id, "Stale edit");
  await vi.waitFor(() => expect(writes).toBe(3));
  gateway.publish({ selfUser: null });
  late.resolve({ status: "ok" });
  await pending;
  expect(controller.workerName(worker.id)).toBeUndefined();
  expect(controller.workerHistoryBusy).toBe(false);
  controller.setPresented(false);
});
