import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationContext } from "../../app/context.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";

export const WORKER_RETENTION_KEY = "ui.workerHistory.retentionMinutes";
export const WORKER_PRESENTATION_KEY = "ui.workerHistory.entries";
export const WORKER_RETENTION_CHOICES = [10, 15, 30, 60] as const;
export type WorkerPresentation = { updatedAtMs: number; name?: string; dismissedAtMs?: number };
export type WorkerPresentations = Record<string, WorkerPresentation>;

export function historyRetention(value: unknown): number {
  return typeof value === "number" && WORKER_RETENTION_CHOICES.some((item) => item === value)
    ? value
    : 15;
}

export function decodeWorkerPresentations(value: unknown): WorkerPresentations {
  if (!isRecord(value)) {
    return {};
  }
  const result: WorkerPresentations = {};
  for (const [id, entry] of Object.entries(value)) {
    if (
      !isRecord(entry) ||
      typeof entry.updatedAtMs !== "number" ||
      !Number.isFinite(entry.updatedAtMs)
    ) {
      continue;
    }
    result[id] = {
      updatedAtMs: entry.updatedAtMs,
      ...(typeof entry.name === "string" && entry.name.trim()
        ? { name: entry.name.trim().slice(0, 80) }
        : {}),
      ...(typeof entry.dismissedAtMs === "number" && Number.isFinite(entry.dismissedAtMs)
        ? { dismissedAtMs: entry.dismissedAtMs }
        : {}),
    };
  }
  return result;
}

/** A failed allocation may still own resources. Never hide pending cleanup. */
export function isFinishedWorker(row: SystemsInventoryRow): boolean {
  const worker = row.environment.worker;
  return (
    worker?.state === "destroyed" ||
    (worker?.state === "failed" && !worker.leaseId && !worker.cleanupPending)
  );
}

export function isWorkerHistoryVisible(
  row: SystemsInventoryRow,
  entries: WorkerPresentations,
  retention: number,
  now: number,
): boolean {
  if (!isFinishedWorker(row)) {
    return true;
  }
  const ended = row.environment.worker?.stateChangedAtMs;
  if (ended === undefined) {
    return true;
  }
  return entries[row.environment.id]?.dismissedAtMs !== ended && now < ended + retention * 60_000;
}

/** Keep one bounded preference value; CAS at the writer preserves concurrent edits. */
export function boundWorkerPresentations(
  entries: WorkerPresentations,
  rows: SystemsInventoryRow[],
  now: number,
): WorkerPresentations | null {
  const known = new Map(rows.map((row) => [row.environment.id, row]));
  const result = Object.fromEntries(
    Object.entries(entries).filter(([id, entry]) => {
      const row = known.get(id);
      if (!row) {
        return false;
      }
      if (entry.name) {
        return true;
      }
      const ended = row.environment.worker?.stateChangedAtMs;
      return (
        ended === undefined ||
        !isFinishedWorker(row) ||
        now < ended + Math.max(...WORKER_RETENTION_CHOICES) * 60_000
      );
    }),
  );
  // A full cache fails visibly instead of silently losing another worker's name or dismissal.
  return new TextEncoder().encode(JSON.stringify(result)).length <= 4000 ? result : null;
}

export function isWorkerPlacementSessionEvent(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return payload.reason === "placement" || payload.reason === "reclaim";
}

export function workerPlacementInventoryKey(context: ApplicationContext): string {
  return (context.sessions.state.result?.sessions ?? [])
    .flatMap((session) => {
      const placement = session.placement;
      if (!placement || placement.state === "local" || placement.state === "requested") {
        return [];
      }
      return [
        [
          session.key,
          placement.generation,
          placement.state,
          placement.environmentId ?? "",
          placement.stateChangedAtMs,
        ].join("\u0000"),
      ];
    })
    .toSorted()
    .join("\u0001");
}
