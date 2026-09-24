/**
 * Durable session snapshot. Never stores provider conversations, source
 * tool results, reasoning, or secret values.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { PROTOCOL_VERSION, STATE_VERSION } from "./constants.mjs";
import { atomicWriteJson, statePath } from "./paths.mjs";

/**
 * @param {object} [overrides]
 */
export function emptyState(overrides = {}) {
  return {
    version: STATE_VERSION,
    enabled: false,
    paused: false,
    pauseReason: null,
    generation: 1,
    workerGeneration: 0,
    settingsRevision: 0,
    projectRoot: null,
    rootIdent: null,
    deliveryProtocolVersion: PROTOCOL_VERSION,
    issuanceUnrecoverable: false,
    ended: false,
    transcriptPath: null,
    activation: null,
    activationFingerprint: null,
    latestTask: null,
    compactSummary: null,
    compaction: null,
    primaryIdle: true,
    contextUnavailable: false,
    cwdOutsideRoot: false,
    observationSeq: 0,
    transcriptCursor: { offset: 0, uuid: null, inode: null, size: 0 },
    dedupe: [],
    usage: {},
    errors: {},
    advisors: {},
    inbox: [],
    issuance: [],
    controlPromptIds: [],
    ...overrides
  };
}


/**
 * @param {unknown} snapshot
 */
export function fingerprintSnapshot(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex");
}

/**
 * @param {string} dir
 */
export async function loadState(dir) {
  try {
    const raw = await fs.readFile(statePath(dir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    const missingIssuance =
      !Object.prototype.hasOwnProperty.call(parsed, "issuance") || !Array.isArray(parsed.issuance);
    const state = normalizeState({ ...emptyState(), ...parsed, version: STATE_VERSION });
    state.issuanceUnrecoverable = Boolean(parsed.issuanceUnrecoverable) || missingIssuance;
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * Fill epoch/issuance defaults so worker replacement cannot resurrect
 * pre-protocol findings as current.
 * @param {object} state
 */
export function normalizeState(state) {
  state.settingsRevision = Number(state.settingsRevision) || 0;
  if (!Array.isArray(state.issuance)) state.issuance = [];
  state.deliveryProtocolVersion = Number(state.deliveryProtocolVersion) || PROTOCOL_VERSION;
  state.issuanceUnrecoverable = Boolean(state.issuanceUnrecoverable);
  state.ended = Boolean(state.ended);
  const advisors = {};
  for (const [name, rec] of Object.entries(state.advisors ?? {})) {
    if (!rec || typeof rec !== "object") continue;
    advisors[name] = {
      ...rec,
      name: rec.name ?? name,
      epoch: Number(rec.epoch) > 0 ? Number(rec.epoch) : 1,
      tombstone: Boolean(rec.tombstone),
      identity: typeof rec.identity === "string" ? rec.identity : null,
      enabled: rec.enabled !== false,
      reasoningEffort: typeof rec.reasoningEffort === "string" ? rec.reasoningEffort : "default"
    };
  }
  state.advisors = advisors;
  if (Array.isArray(state.inbox)) {
    for (const item of state.inbox) {
      if (!item || typeof item !== "object") continue;
      if (item.deliverable == null) {
        item.deliverable = item.status !== "discarded" && item.status !== "stale";
      }
    }
  } else {
    state.inbox = [];
  }
  return state;
}


/**
 * @param {string} dir
 * @param {object} state
 */
export async function saveState(dir, state) {
  const durable = persistable(state);
  await atomicWriteJson(statePath(dir), durable);
  return durable;
}

/**
 * Strip in-memory-only fields before disk. Histories and review controllers
 * stay in the worker process.
 * @param {object} state
 */
export function persistable(state) {
  const advisors = {};
  for (const [name, advisor] of Object.entries(state.advisors ?? {})) {
    advisors[name] = {
      name: advisor.name,
      provider: advisor.provider,
      model: advisor.model,
      kind: advisor.kind,
      enabled: advisor.enabled !== false,
      reasoningEffort: advisor.reasoningEffort ?? "default",
      epoch: Number(advisor.epoch) > 0 ? Number(advisor.epoch) : 1,
      tombstone: Boolean(advisor.tombstone),
      identity: typeof advisor.identity === "string" ? advisor.identity : null,
      reviews: advisor.reviews ?? 0,
      consecutiveFailures: advisor.consecutiveFailures ?? 0,
      paused: advisor.paused ?? false,
      pauseReason: advisor.pauseReason ?? null,
      lastError: advisor.lastError ?? null,
      usage: advisor.usage ?? null,
      fingerprints: Array.isArray(advisor.fingerprints)
        ? advisor.fingerprints.slice(-4096)
        : [],
      cursor: advisor.cursor ?? 0
    };
  }
  return {
    version: STATE_VERSION,
    enabled: Boolean(state.enabled),
    paused: Boolean(state.paused),
    pauseReason: state.pauseReason ?? null,
    generation: Number(state.generation) || 1,
    workerGeneration: Number(state.workerGeneration) || 0,
    settingsRevision: Number(state.settingsRevision) || 0,
    deliveryProtocolVersion: PROTOCOL_VERSION,
    issuanceUnrecoverable: Boolean(state.issuanceUnrecoverable),
    ended: Boolean(state.ended),
    projectRoot: state.projectRoot ?? null,
    rootIdent: state.rootIdent ?? null,
    transcriptPath: state.transcriptPath ?? null,
    activation: state.activation ?? null,
    latestTask: boundTask(state.latestTask),
    compactSummary: boundTask(state.compactSummary),
    compaction: state.compaction ?? null,
    primaryIdle: Boolean(state.primaryIdle),
    contextUnavailable: Boolean(state.contextUnavailable),
    cwdOutsideRoot: Boolean(state.cwdOutsideRoot),
    observationSeq: Number(state.observationSeq) || 0,
    transcriptCursor: state.transcriptCursor ?? { offset: 0, uuid: null, inode: null, size: 0 },
    dedupe: Array.isArray(state.dedupe) ? state.dedupe.slice(-8192) : [],
    usage: state.usage ?? {},
    errors: state.errors ?? {},
    advisors,
    inbox: Array.isArray(state.inbox) ? state.inbox : [],
    issuance: Array.isArray(state.issuance) ? state.issuance : [],
    controlPromptIds: Array.isArray(state.controlPromptIds)
      ? state.controlPromptIds.slice(-512)
      : []
  };
}

function boundTask(task) {
  if (!task || typeof task !== "object") return null;
  const text = typeof task.text === "string" ? task.text.slice(0, 8 * 1024) : "";
  return {
    text,
    promptId: task.promptId ?? null,
    at: task.at ?? null,
    generation: task.generation ?? null,
    truncated: Boolean(task.truncated) || (typeof task.text === "string" && task.text.length > 8 * 1024)
  };
}
