/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SystemsController } from "./systems-controller.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("paces worker placement invalidations and ignores unrelated session changes", async () => {
  const environments: EnvironmentSummary[] = [
    { id: "gateway", type: "local", label: "Gateway", status: "available" },
  ];
  const request = vi.fn(async (method: string) => {
    if (method === "environments.list") {
      return { environments };
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
  const sessions = createSessionsHarness("main", []).sessions;
  const context = createContext(gateway.gateway, sessions);
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  Object.assign(context, { runtimeConfig });
  const controller = new SystemsController(context);
  controller.setPresented(true);
  await vi.waitFor(() => expect(controller.inventory).not.toBeNull());

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
  runtimeConfig.dispose();
});
