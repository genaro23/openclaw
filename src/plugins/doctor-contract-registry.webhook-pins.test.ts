import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordReadOnlyWebhookCompletion } from "../commands/doctor/shared/legacy-webhook-pins.js";
import { createConfigIO } from "../config/io.factory.js";
import { replaceConfigFile } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordGatewayBootStart } from "../infra/gateway-boot-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { applyPluginDoctorCompatibilityMigrations } from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    clearPluginDoctorContractRegistryCache();
    await closeStateDatabaseForTest();
    cleanup();
  });
});
const endpoint = { port: 8788, host: "0.0.0.0" };

async function fixture(
  accountIds: Array<string | undefined> = ["work"],
  options: {
    channelId?: "nextcloud-talk" | "msteams";
    preserveAuthoredActivation?: true;
    unreportedEdit?: true;
  } = {},
) {
  const channelId = options.channelId ?? "nextcloud-talk";
  const root = tempDirs.make("openclaw-doctor-webhook-pins-");
  const configPath = path.join(root, "openclaw.json");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  await fs.writeFile(
    path.join(root, "doctor-contract-api.cjs"),
    `module.exports = {
      historicalWebhookListener: ${JSON.stringify({
        channelId,
        ...(channelId === "msteams" ? { port: 3978 } : endpoint),
        ...(options.preserveAuthoredActivation ? { preserveAuthoredActivation: true } : {}),
      })},
      normalizeCompatibilityConfig: ({ cfg }) => {
        ${options.unreportedEdit ? "cfg.gateway = { port: 10000 };" : ""}
        return { config: cfg, changes: [], historicalWebhookAccountIds: [${accountIds.map((id) => (id === undefined ? "undefined" : JSON.stringify(id))).join(", ")}] };
      }
    };\n`,
  );
  const manifestRegistry = {
    plugins: [
      createPluginManifestRecordFixture({
        id: channelId,
        rootDir: root,
        channels: [channelId],
        doctorContract: { configRepair: true },
      }),
    ],
    diagnostics: [],
  };
  const migrate = (config: OpenClawConfig, migrationEnv: NodeJS.ProcessEnv = env) =>
    applyPluginDoctorCompatibilityMigrations(config, {
      env: migrationEnv,
      pluginIds: [channelId],
      manifestRegistry,
      historicalWebhookListeners: true,
    });
  return { configPath, env, migrate };
}

function channelConfig(accounts: Record<string, Record<string, unknown>>): OpenClawConfig {
  return { channels: { "nextcloud-talk": { accounts } } };
}

describe("Doctor historical webhook pins", () => {
  it("uses no-op eligibility without publishing unreported hook edits", async () => {
    const { env, migrate } = await fixture(["work"], { unreportedEdit: true });
    const config = channelConfig({ work: { enabled: true } });
    const result = migrate(config, { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" });
    expect(result.warnings).toBeUndefined();
    expect(config).toEqual(channelConfig({ work: { enabled: true } }));
    expect(result.config).not.toHaveProperty("gateway");
    expect(result.config.channels?.["nextcloud-talk"]).toEqual({
      accounts: { work: { enabled: true, legacyWebhook: endpoint } },
    });
  });

  it.each(["previous boot", "published updater"])(
    "backs up and pins a %s install once, then preserves a removed pin",
    async (evidence) => {
      const { configPath, env, migrate } = await fixture();
      const original = JSON.stringify(channelConfig({ work: { enabled: true } }));
      await fs.writeFile(configPath, original);
      if (evidence === "previous boot") {
        expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();
      }
      const io = createConfigIO({
        env,
        configPath,
        observe: false,
        pluginValidation: "skip",
        shellEnvFallback: "defer",
      });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      expect(snapshot.valid).toBe(true);
      const result = migrate(snapshot.sourceConfig, {
        ...env,
        ...(evidence === "published updater" ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {}),
      });
      expect(result.warnings).toBeUndefined();
      await replaceConfigFile({
        io,
        snapshot,
        nextConfig: result.config,
        writeOptions: { ...writeOptions, observe: false, skipPluginValidation: true },
      });
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
      const saved = await io.readConfigFileSnapshot({ observe: false });
      expect(saved.sourceConfig.channels?.["nextcloud-talk"]).toEqual({
        accounts: { work: { enabled: true, legacyWebhook: endpoint } },
      });
      expect(saved.sourceConfig.meta?.migrations?.webhookListeners).toMatchObject({
        "nextcloud-talk": expect.any(Array),
      });
      const removed = {
        ...saved.sourceConfig,
        ...channelConfig({ work: { enabled: true } }),
      };
      await replaceConfigFile({
        io,
        snapshot: saved,
        nextConfig: removed,
        writeOptions: { observe: false, skipPluginValidation: true },
      });
      const removedBytes = await fs.readFile(configPath, "utf8");
      const reloaded = await io.readConfigFileSnapshot({ observe: false });
      expect(migrate(reloaded.sourceConfig)).toEqual({
        config: reloaded.sourceConfig,
        changes: [],
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(removedBytes);
      expect(reloaded.sourceConfig.channels?.["nextcloud-talk"]).toEqual({
        accounts: { work: { enabled: true } },
      });
    },
  );

  it.each(["no database", "empty database"])(
    "completes a fresh install with %s without pins even after its first Gateway boot",
    async (state) => {
      const { env, migrate } = await fixture();
      if (state === "empty database") {
        openOpenClawStateDatabase({ env });
        await closeStateDatabaseForTest();
      }
      const config = channelConfig({ work: { enabled: true } });
      const fresh = migrate(config);
      expect(fresh.config.channels).toEqual(config.channels);
      expect(fresh.config.meta?.migrations?.webhookListeners).toBe(true);
      expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();
      expect(migrate(fresh.config)).toEqual({ config: fresh.config, changes: [] });
    },
  );

  it("keeps read-only completion when a managed config symlink selects a new generation", async () => {
    const { configPath, env, migrate } = await fixture();
    const readOnlyEnv = { ...env, OPENCLAW_CONFIG_READONLY: "1" };
    const config = channelConfig({ work: { enabled: true } });
    const bytes = JSON.stringify(config);
    const firstGeneration = path.join(path.dirname(configPath), "generation-1.json");
    const nextGeneration = path.join(path.dirname(configPath), "generation-2.json");
    await fs.writeFile(firstGeneration, bytes);
    await fs.writeFile(nextGeneration, bytes);
    await fs.symlink(firstGeneration, configPath, "file");
    const fresh = migrate(config, readOnlyEnv);
    expect(fresh.config.meta?.migrations?.webhookListeners).toBe(true);
    expect(recordReadOnlyWebhookCompletion(config, fresh, readOnlyEnv)).toBe(true);
    expect(migrate(config, readOnlyEnv)).toEqual({ config, changes: [] });
    expect(recordGatewayBootStart(env, 1_800_000_000_000)).toBeDefined();

    await fs.unlink(configPath);
    await fs.symlink(nextGeneration, configPath, "file");
    const redeployed: OpenClawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(migrate(redeployed, readOnlyEnv)).toEqual({ config: redeployed, changes: [] });
    expect(await fs.readFile(firstGeneration, "utf8")).toBe(bytes);
    expect(await fs.readFile(nextGeneration, "utf8")).toBe(bytes);
  });

  it.each([
    { keys: ["work", "Work"], pinned: "work" },
    { keys: ["Work"], pinned: "Work" },
  ])("pins only the selected authored key: $keys", async ({ keys, pinned }) => {
    const { env, migrate } = await fixture();
    const accounts = Object.fromEntries(keys.map((key) => [key, { enabled: true }]));
    const result = migrate(channelConfig(accounts), { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" });
    expect(result.warnings).toBeUndefined();
    expect(result.config.channels?.["nextcloud-talk"]).toEqual({
      accounts: { ...accounts, [pinned]: { enabled: true, legacyWebhook: endpoint } },
    });
  });

  it("warns without publishing partial pins when an account alias is ambiguous", async () => {
    const { env, migrate } = await fixture(["unambiguous", "work"]);
    const config = channelConfig({ unambiguous: {}, Work: {}, WORK: {} });
    const result = migrate(config, { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" });
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('Ambiguous nextcloud-talk account "work"'),
    ]);
    expect(result.warnings?.[0]).toContain('"Work", "WORK"');
    expect(result.warnings?.[0]).toContain(
      'channels.nextcloud-talk.accounts[<exact account key>].legacyWebhook = {"port":8788,"host":"0.0.0.0"}',
    );
  });

  it.each([false, { port: 9999 }])("preserves an explicit inherited endpoint: %j", async (pin) => {
    const { env, migrate } = await fixture();
    const config = {
      channels: { "nextcloud-talk": { legacyWebhook: pin, accounts: { work: {} } } },
    };
    const result = migrate(config, { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" });
    expect(result.config.channels).toEqual(config.channels);
    expect(result.config.meta?.migrations?.webhookListeners).toHaveProperty("nextcloud-talk");
  });

  it.each([
    { name: "endpoint", legacyWebhook: { port: 9397 }, enabled: undefined, expectedEnabled: true },
    { name: "opt-out", legacyWebhook: false as const, enabled: undefined, expectedEnabled: true },
    {
      name: "disabled channel",
      legacyWebhook: { port: 9397 },
      enabled: false,
      expectedEnabled: false,
    },
  ])(
    "preserves authored Teams activation with $name",
    async ({ legacyWebhook, enabled, expectedEnabled }) => {
      const { env, migrate } = await fixture([undefined], {
        channelId: "msteams",
        preserveAuthoredActivation: true,
      });
      const result = migrate(
        { channels: { msteams: { legacyWebhook, ...(enabled === undefined ? {} : { enabled }) } } },
        { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      );
      expect(result.warnings).toBeUndefined();
      expect(result.config.channels?.msteams).toEqual({ legacyWebhook, enabled: expectedEnabled });
      expect(result.config.meta?.migrations?.webhookListeners).toEqual({
        msteams: enabled === undefined ? [["channels", "msteams", "enabled"]] : [],
      });
    },
  );

  it("does not turn an environment-only Teams pin into authored activation on a later Doctor run", async () => {
    const { env, migrate } = await fixture([undefined], {
      channelId: "msteams",
      preserveAuthoredActivation: true,
    });
    const updateEnv = { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" };
    const first = migrate({}, updateEnv);
    expect(first.config.channels?.msteams).toEqual({ legacyWebhook: { port: 3978 } });
    expect(migrate(first.config, updateEnv)).toEqual({ config: first.config, changes: [] });
  });
});
