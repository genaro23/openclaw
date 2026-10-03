import fs from "node:fs";
import path from "node:path";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveOAuthDir } from "openclaw/plugin-sdk/state-paths";
import { isWhatsAppBaileysAuthFileName } from "./creds-files.js";
import { normalizeCompatibilityConfig as normalizeAckReactionConfig } from "./doctor.js";

// WhatsApp's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode, so only the delivery flat aliases are legal legacy
// input. WhatsApp resolution layers accounts.default shared config between the
// channel root and named accounts, so the shared migration materializes that
// inheritance when it creates a named-account streaming object.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "whatsapp",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingInheritsDefaultAccount: true,
});

const hasExposeErrorText = (value: unknown): boolean =>
  Object.hasOwn(asObjectRecord(value) ?? {}, "exposeErrorText");

const hasAckReaction = (value: unknown): boolean =>
  Boolean(asObjectRecord(asObjectRecord(value)?.ackReaction));

// The old generic seeder moved only these shared WhatsApp policy fields.
const synthesizedDefaultPolicyKeys = new Set([
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
]);

function hasSynthesizedDefault(cfg: OpenClawConfig): boolean {
  const channel = asObjectRecord(cfg.channels?.whatsapp);
  const accounts = asObjectRecord(channel?.accounts);
  const fallback = asObjectRecord(accounts?.default);
  if (
    !channel ||
    !accounts ||
    !fallback ||
    channel.authDir !== undefined ||
    (typeof channel.defaultAccount === "string" &&
      channel.defaultAccount.trim().toLowerCase() === "default") ||
    Object.keys(accounts).length < 2
  ) {
    return false;
  }
  const keys = Object.keys(fallback);
  if (
    keys.length === 0 ||
    keys.some((key) => !synthesizedDefaultPolicyKeys.has(key)) ||
    Object.values(accounts).some((account) => !asObjectRecord(account)) ||
    cfg.bindings?.some(
      (binding) =>
        binding.match.channel.trim().toLowerCase() === "whatsapp" &&
        binding.match.accountId?.trim().toLowerCase() === "default",
    )
  ) {
    return false;
  }
  const oauthDir = resolveOAuthDir();
  // Credentials may use the implicit directory, including a legacy root or
  // backup. Unreadable state is not evidence that an account is unlinked.
  for (const dir of [oauthDir, path.join(oauthDir, "whatsapp", "default")]) {
    try {
      if (fs.readdirSync(dir).some(isWhatsAppBaileysAuthFileName)) {
        return false;
      }
    } catch (error) {
      if (asObjectRecord(error)?.code !== "ENOENT") {
        return false;
      }
    }
  }
  return true;
}

function repairSynthesizedDefault(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const channel = cfg.channels?.whatsapp;
  if (!channel?.accounts || !hasSynthesizedDefault(cfg)) {
    return cfg;
  }
  const { default: sharedPolicy, ...accounts } = channel.accounts;
  changes.push(
    "Removed synthesized channels.whatsapp.accounts.default; restored shared policy at the channel root and the existing account route.",
  );
  return {
    ...cfg,
    channels: { ...cfg.channels, whatsapp: { ...channel, ...sharedPolicy, accounts } },
  };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "whatsapp"],
    message:
      'A synthesized WhatsApp default account shadows named accounts; run "openclaw doctor --fix" to restore shared root policy and account routing.',
    match: (_value, cfg) => hasSynthesizedDefault(cfg),
  },
  {
    path: ["channels", "whatsapp", "ackReaction"],
    message:
      'channels.whatsapp.ackReaction moved to global message acknowledgement settings. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "whatsapp", "accounts"],
    message:
      'channels.whatsapp.accounts.<id>.ackReaction moved to global message acknowledgement settings. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasAckReaction),
  },
  {
    path: ["channels", "whatsapp", "exposeErrorText"],
    message:
      'channels.whatsapp.exposeErrorText is retired and ignored. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "whatsapp", "accounts"],
    message:
      'channels.whatsapp.accounts.<id>.exposeErrorText is retired and ignored. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasExposeErrorText),
  },
];

function removeExposeErrorText(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  return stripRetiredChannelKeys({
    cfg,
    channelId: "whatsapp",
    keys: new Set(["exposeErrorText"]),
    scope: "root-and-accounts",
    onRemove: ({ key, pathPrefix }) => changes.push(`Removed retired ${pathPrefix}.${key}.`),
  }).config;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const repaired = repairSynthesizedDefault(cfg, changes);
  const ackReaction = normalizeAckReactionConfig({ cfg: repaired });
  ackReaction.changes.unshift(...changes);
  const retiredConfig = removeExposeErrorText(ackReaction.config, ackReaction.changes);
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: retiredConfig,
    changes: ackReaction.changes,
  });
}
