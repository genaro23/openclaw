import { afterAll, expect, it } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  runLiveRuntimeToolFixture,
  runtimeToolFixtureConfig,
  transcriptToolCall,
  transcriptToolResult,
  writeRuntimeToolTranscripts,
  writeToolSearchDiscoveryEvidence,
} from "../test/runtime-tool-fixture-helpers.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

async function writeLiveRuntimeToolEvidence(env: QaSuiteRuntimeEnv) {
  await writeRuntimeToolTranscripts(
    env,
    "web_search",
    [
      transcriptToolCall("web_search", "happy", { query: "qa" }),
      transcriptToolResult("web_search", "happy", "result"),
    ],
    [
      transcriptToolCall("web_search", "failure", { query: "" }),
      transcriptToolResult("web_search", "failure", "required", true),
    ],
  );
}

afterAll(cleanupRuntimeToolFixtureTempRoots);

const config = runtimeToolFixtureConfig("web_search", {
  toolCoverage: {
    bucket: "openclaw-dynamic-integration",
    expectedLayer: "openclaw-dynamic",
    capabilityLayer: "openclaw-dynamic-searchable",
    required: true,
  },
});

it.each(["happy", "failure"] as const)(
  "rejects a discovery receipt for a different %s target call",
  async (mismatchedPhase) => {
    const env = await makeEnv();
    await writeLiveRuntimeToolEvidence(env);
    for (const phase of ["happy", "failure"] as const) {
      writeToolSearchDiscoveryEvidence(
        env,
        "web_search",
        phase,
        phase === mismatchedPhase ? `other-${phase}` : `call-web_search-${phase}`,
      );
    }
    await expect(
      runLiveRuntimeToolFixture(env, { toolName: "web_search", config }),
    ).rejects.toThrow(`expected live ${mismatchedPhase}-path tool_search discovery for web_search`);
  },
);

it("requires linked discovery receipts for live searchable Codex tools", async () => {
  const missingEnv = await makeEnv();
  await writeLiveRuntimeToolEvidence(missingEnv);
  await expect(
    runLiveRuntimeToolFixture(missingEnv, { toolName: "web_search", config }),
  ).rejects.toThrow("expected live happy-path tool_search discovery for web_search");

  const observedEnv = await makeEnv();
  await writeLiveRuntimeToolEvidence(observedEnv);
  writeToolSearchDiscoveryEvidence(observedEnv, "web_search", "happy");
  writeToolSearchDiscoveryEvidence(observedEnv, "web_search", "failure");
  await expect(
    runLiveRuntimeToolFixture(observedEnv, { toolName: "web_search", config }),
  ).resolves.toContain(
    "web_search live provider discovery receipts: happy=search-happy failure=search-failure",
  );
});
