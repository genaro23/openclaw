import type { ApplicationContext } from "../../app/context.ts";
import { invalidateUserPreferences, saveUserPreferences } from "../../app/user-prefs-cache.ts";
import { loadUserPreferences } from "../../app/user-prefs-request.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import {
  WORKER_RETENTION_KEY,
  WORKER_PRESENTATION_KEY,
  WORKER_RETENTION_CHOICES,
  historyRetention,
  decodeWorkerPresentations,
  isFinishedWorker,
  boundWorkerPresentations,
  type WorkerPresentations,
} from "./systems-worker-history.ts";

export class SystemsWorkerPreferences {
  historyRetentionMinutes = 15;
  workerHistoryBusy = false;
  workerHistoryError: string | null = null;
  workerPresentations: WorkerPresentations = {};
  private workerPreferencesGeneration = 0;
  workerPreferencesProfile: string | null = null;
  constructor(
    private readonly owner: {
      context: ApplicationContext;
      presented: () => boolean;
      current: () => boolean;
      connected: () => boolean;
      rows: () => SystemsInventoryRow[];
      lifecycle: ReturnType<typeof createGatewayConnectionLifecycle>;
      notify: () => void;
    },
  ) {}
  cancel(): void {
    this.workerPreferencesGeneration += 1;
    this.workerHistoryBusy = false;
  }
  get canEditWorkerPreferences(): boolean {
    return (
      this.owner.presented() &&
      this.owner.connected() &&
      Boolean(this.owner.context.gateway.snapshot.selfUser?.id)
    );
  }

  workerName(id: string): string | undefined {
    return this.owner.current() ? this.workerPresentations[id]?.name : undefined;
  }

  canDismissWorker(row: SystemsInventoryRow): boolean {
    return (
      this.canEditWorkerPreferences &&
      isFinishedWorker(row) &&
      row.environment.worker?.stateChangedAtMs !== undefined &&
      this.workerPresentations[row.environment.id]?.dismissedAtMs !==
        row.environment.worker.stateChangedAtMs
    );
  }

  async dismissWorker(id: string): Promise<void> {
    const row = this.owner.rows().find((item) => item.environment.id === id);
    if (!row || this.workerHistoryBusy || !this.canDismissWorker(row)) {
      return;
    }
    const ended = row.environment.worker!.stateChangedAtMs!;
    await this.writeWorkerPreferences((entries) => ({
      [WORKER_PRESENTATION_KEY]: this.boundedWorkerPresentations({
        ...decodeWorkerPresentations(entries[WORKER_PRESENTATION_KEY]),
        [id]: {
          ...decodeWorkerPresentations(entries[WORKER_PRESENTATION_KEY])[id],
          updatedAtMs: Date.now(),
          dismissedAtMs: ended,
        },
      }),
    }));
  }

  async renameWorker(id: string, name: string): Promise<void> {
    if (name.trim().length > 80) {
      this.workerHistoryError = t("systems.workerHistorySaveFailed");
      this.owner.notify();
      return;
    }
    if (!this.owner.rows().some((row) => row.environment.id === id && row.environment.worker)) {
      return;
    }
    await this.writeWorkerPreferences((entries) => {
      const values = decodeWorkerPresentations(entries[WORKER_PRESENTATION_KEY]);
      const entry = { ...values[id], updatedAtMs: Date.now() };
      const trimmed = name.trim();
      if (trimmed) {
        entry.name = trimmed;
      } else {
        delete entry.name;
      }
      values[id] = entry;
      return { [WORKER_PRESENTATION_KEY]: this.boundedWorkerPresentations(values) };
    });
  }

  async setHistoryRetentionMinutes(value: number): Promise<void> {
    if (!WORKER_RETENTION_CHOICES.some((choice) => choice === value)) {
      return;
    }
    await this.writeWorkerPreferences(() => ({ [WORKER_RETENTION_KEY]: value }));
  }

  private boundedWorkerPresentations(entries: WorkerPresentations): WorkerPresentations {
    const bounded = boundWorkerPresentations(entries, this.owner.rows(), Date.now());
    if (!bounded) {
      throw new Error(t("systems.workerHistorySaveFailed"));
    }
    return bounded;
  }

  resetWorkerPreferences(): void {
    this.workerPreferencesGeneration += 1;
    this.workerPreferencesProfile = this.owner.context.gateway.snapshot.selfUser?.id ?? null;
    this.workerHistoryBusy = false;
    this.workerHistoryError = null;
    this.historyRetentionMinutes = 15;
    this.workerPresentations = {};
  }

  private applyWorkerPreferences(entries: Record<string, unknown>): void {
    this.historyRetentionMinutes = historyRetention(entries[WORKER_RETENTION_KEY]);
    this.workerPresentations = decodeWorkerPresentations(entries[WORKER_PRESENTATION_KEY]);
  }

  async loadWorkerPreferences(): Promise<void> {
    const scope = this.owner.lifecycle.capture();
    const profile = this.owner.context.gateway.snapshot.selfUser?.id;
    if (!scope || !profile || !this.canEditWorkerPreferences || this.workerHistoryBusy) {
      return;
    }
    const generation = ++this.workerPreferencesGeneration;
    const isCurrent = () =>
      this.owner.presented() &&
      this.owner.current() &&
      this.owner.lifecycle.isCurrent(scope) &&
      this.owner.context.gateway.snapshot.selfUser?.id === profile &&
      this.workerPreferencesGeneration === generation;
    try {
      const result = await loadUserPreferences(scope.client, profile, {
        keys: [WORKER_RETENTION_KEY, WORKER_PRESENTATION_KEY],
      });
      if (!isCurrent()) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(t("systems.workerHistorySaveFailed"));
      }
      this.applyWorkerPreferences(result.entries);
      this.workerHistoryError = null;
    } catch (error) {
      if (isCurrent()) {
        this.workerHistoryError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.owner.notify();
      }
    }
  }

  private async writeWorkerPreferences(
    update: (entries: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const scope = this.owner.lifecycle.capture();
    const profile = this.owner.context.gateway.snapshot.selfUser?.id;
    if (!scope || !profile || !this.canEditWorkerPreferences || this.workerHistoryBusy) {
      return;
    }
    const generation = ++this.workerPreferencesGeneration;
    const isCurrent = () =>
      this.owner.presented() &&
      this.owner.current() &&
      this.owner.lifecycle.isCurrent(scope) &&
      this.owner.context.gateway.snapshot.selfUser?.id === profile &&
      this.workerPreferencesGeneration === generation;
    this.workerHistoryBusy = true;
    this.workerHistoryError = null;
    this.owner.notify();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        invalidateUserPreferences(scope.client);
        const result = await loadUserPreferences(scope.client, profile, {
          keys: [WORKER_RETENTION_KEY, WORKER_PRESENTATION_KEY],
        });
        if (!isCurrent()) {
          return;
        }
        if (result.status !== "ok") {
          throw new Error(t("systems.workerHistorySaveFailed"));
        }
        const entries = update(result.entries);
        const expectedEntries = Object.fromEntries(
          Object.keys(entries).map((key) => [key, result.entries[key] ?? null]),
        );
        const saved = await saveUserPreferences(scope.client, { entries, expectedEntries });
        if (!isCurrent()) {
          return;
        }
        if (saved.status === "conflict") {
          continue;
        }
        if (saved.status !== "ok") {
          throw new Error(t("systems.workerHistorySaveFailed"));
        }
        this.applyWorkerPreferences({ ...result.entries, ...entries });
        return;
      }
      throw new Error(t("systems.workerHistorySaveFailed"));
    } catch (error) {
      if (isCurrent()) {
        this.workerHistoryError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.workerHistoryBusy = false;
        this.owner.notify();
        // Catch publications received while the write owned the projection.
        if (!this.workerHistoryError) {
          void this.loadWorkerPreferences();
        }
      }
    }
  }
}
