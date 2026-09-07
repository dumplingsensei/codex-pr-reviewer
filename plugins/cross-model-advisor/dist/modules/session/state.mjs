import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/state.mjs
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { STATE_VERSION } from "./constants.mjs";
import { atomicWriteJson, statePath } from "./paths.mjs";
function emptyState(overrides = {}) {
  return {
    version: STATE_VERSION,
    enabled: false,
    paused: false,
    pauseReason: null,
    generation: 1,
    workerGeneration: 0,
    projectRoot: null,
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
    controlPromptIds: [],
    ...overrides
  };
}
function fingerprintSnapshot(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex");
}
async function loadState(dir) {
  try {
    const raw = await fs.readFile(statePath(dir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    return { ...emptyState(), ...parsed, version: STATE_VERSION };
  } catch {
    return emptyState();
  }
}
async function saveState(dir, state) {
  const durable = persistable(state);
  await atomicWriteJson(statePath(dir), durable);
  return durable;
}
function persistable(state) {
  const advisors = {};
  for (const [name, advisor] of Object.entries(state.advisors ?? {})) {
    advisors[name] = {
      name: advisor.name,
      provider: advisor.provider,
      model: advisor.model,
      kind: advisor.kind,
      reviews: advisor.reviews ?? 0,
      consecutiveFailures: advisor.consecutiveFailures ?? 0,
      paused: advisor.paused ?? false,
      pauseReason: advisor.pauseReason ?? null,
      lastError: advisor.lastError ?? null,
      usage: advisor.usage ?? null,
      fingerprints: Array.isArray(advisor.fingerprints) ? advisor.fingerprints.slice(-4096) : [],
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
    controlPromptIds: Array.isArray(state.controlPromptIds) ? state.controlPromptIds.slice(-512) : []
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
    truncated: Boolean(task.truncated) || typeof task.text === "string" && task.text.length > 8 * 1024
  };
}
export {
  emptyState,
  fingerprintSnapshot,
  loadState,
  persistable,
  saveState
};
