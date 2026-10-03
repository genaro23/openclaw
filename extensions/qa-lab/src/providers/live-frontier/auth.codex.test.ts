import { describe, expect, it, vi } from "vitest";
import { assertQaLiveCodexAuthAvailable } from "./auth.js";

const codexHome = "/host/.codex";

describe("Codex-backed live QA auth preflight", () => {
  it("fails when the Codex home has neither OAuth nor an active API key", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: { CODEX_HOME: codexHome },
        readCodexCredentials: () => null,
        readCodexApiKey: () => null,
      }),
    ).toThrow("QA live-frontier cannot run Codex-backed OpenAI models");
  });

  it("returns an API-key-only Codex home credential for the child without mutating inputs", () => {
    const cfg = {};
    const env = { CODEX_HOME: codexHome };
    const apiKey = "synthetic-qa-key";
    const readCodexCredentials = vi.fn(() => null);
    const readCodexApiKey = vi.fn(() => ({
      type: "api_key" as const,
      provider: "openai" as const,
      key: apiKey,
    }));

    const childEnvPatch = assertQaLiveCodexAuthAvailable({
      cfg,
      providerIds: ["openai"],
      env,
      readCodexCredentials,
      readCodexApiKey,
    });

    expect(childEnvPatch).toEqual({ CODEX_API_KEY: apiKey });
    expect(env).toEqual({ CODEX_HOME: codexHome });
    expect(cfg).toEqual({});
    expect(JSON.stringify(env)).not.toContain(apiKey);
    expect(JSON.stringify(cfg)).not.toContain(apiKey);
    expect(readCodexCredentials).toHaveBeenCalledWith({
      codexHome,
      allowKeychainPrompt: false,
      ttlMs: 5_000,
    });
    expect(readCodexApiKey).toHaveBeenCalledWith({
      codexHome,
      allowKeychainPrompt: false,
    });
  });

  it("retains OAuth-first Codex home acceptance", () => {
    const readCodexCredentials = vi.fn(() => ({
      type: "oauth" as const,
      provider: "openai" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }));
    const readCodexApiKey = vi.fn(() => null);

    expect(
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: { CODEX_HOME: codexHome },
        readCodexCredentials,
        readCodexApiKey,
      }),
    ).toBeUndefined();
    expect(readCodexCredentials).toHaveBeenCalledWith({
      codexHome,
      allowKeychainPrompt: false,
      ttlMs: 5_000,
    });
    expect(readCodexApiKey).not.toHaveBeenCalled();
  });
});
