import type { QaProviderMode } from "./model-selection.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

export function partitionSharedQaFlowScenarios(
  scenarios: readonly QaSeedScenarioWithSource[],
  concurrency: number,
  maxPartitions: number,
) {
  const partitionCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, Math.floor(maxPartitions)),
    scenarios.length,
  );
  const partitions = Array.from({ length: partitionCount }, (): QaSeedScenarioWithSource[] => []);
  for (const [index, scenario] of scenarios.entries()) {
    const partition = partitions[index % partitionCount];
    if (!partition) {
      throw new Error("failed to partition shared QA flow scenarios");
    }
    partition.push(scenario);
  }
  return partitions.filter((partition) => partition.length > 0);
}

export function resolveQaScenarioRuntimeRoute(
  scenario: QaSeedScenarioWithSource,
  providerMode: QaProviderMode,
) {
  if (scenario.execution.kind !== "flow") {
    return [];
  }
  const configuredRuntime =
    providerMode === "live-frontier" ? scenario.execution.liveConfiguredRuntime : undefined;
  const runtime = configuredRuntime ?? scenario.execution.runtime;
  return runtime
    ? [
        {
          runtime,
          runtimeSelection: configuredRuntime ? ("configured" as const) : ("forced" as const),
          scenario,
        },
      ]
    : [];
}
