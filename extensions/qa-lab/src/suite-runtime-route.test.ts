import { describe, expect, it } from "vitest";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { resolveQaScenarioRuntimeRoute } from "./suite-runtime-route.js";

function makeFlowScenario(execution: Record<string, unknown>): QaSeedScenarioWithSource {
  return {
    id: "runtime-tool-session-status",
    execution: { kind: "flow", ...execution },
  } as QaSeedScenarioWithSource;
}

describe("resolveQaScenarioRuntimeRoute", () => {
  it("uses product-configured Codex selection for live searchable scenarios", () => {
    const scenario = makeFlowScenario({ liveConfiguredRuntime: "codex" });

    expect(resolveQaScenarioRuntimeRoute(scenario, "live-frontier")).toEqual([
      { runtime: "codex", runtimeSelection: "configured", scenario },
    ]);
  });

  it("does not turn the live-only route into forced mock runtime selection", () => {
    const scenario = makeFlowScenario({ liveConfiguredRuntime: "codex" });

    expect(resolveQaScenarioRuntimeRoute(scenario, "mock-openai")).toEqual([]);
  });

  it("retains explicit forced runtime routes", () => {
    const scenario = makeFlowScenario({ runtime: "codex" });

    expect(resolveQaScenarioRuntimeRoute(scenario, "live-frontier")).toEqual([
      { runtime: "codex", runtimeSelection: "forced", scenario },
    ]);
  });
});
