#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/worker.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_LEASE_MS,
  DEBOUNCE_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_REVIEWS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DRAIN_EVENTS,
  IDLE_EXIT_MS,
  PROTOCOL_VERSION,
  SESSION_RETENTION_MS,
  SETTINGS_ERRORS,
  USER_TEXT_CAP,
  WORKER_UMASK
} from "./session/constants.mjs";
import { createErrorLog } from "./session/errors.mjs";
import {
  acknowledgeClaim,
  acceptedFinding,
  adoptLegacyIssuance,
  claimFindings,
  clearIssuance,
  clientsMatch,
  discardInjectable,
  fenceAdvisorFindings,
  findingEligible,
  normalizeClient,
  ownershipDenyCode,
  pruneIssuance,
  recordIssuance,
  releaseClaim,
  retainPreCompact
} from "./session/findings.mjs";
import { boundHistory, currentContextFits } from "./session/history.mjs";
import { listenIpc, randomCapability, randomId } from "./session/ipc.mjs";
import {
  dedupeKey,
  mergeToolObservation,
  observationFromHook,
  observationFromTranscript,
  rememberDedupe,
  seenDedupe
} from "./session/observations.mjs";
import {
  atomicWriteJson,
  createSocketDir,
  ensurePrivateDir,
  lockDir,
  locatorPath,
  pidIsLive,
  sessionDir as sessionDirectory,
  validateSessionId
} from "./session/paths.mjs";
import {
  classifyExpansion,
  classifyPrompt
} from "./session/classifier.mjs";
import {
  resolveSecrets,
  sanitizeText,
  secretNamesFromSnapshot,
  truncateLabeled
} from "./session/sanitize.mjs";
import { emptyState, fingerprintSnapshot, loadState, saveState } from "./session/state.mjs";
import {
  interpretRecord,
  readTranscriptIncrement,
  recoverCompactSummary,
  recoverLatestTask
} from "./session/transcript.mjs";
var PAUSE_IMMEDIATE = /* @__PURE__ */ new Set(["rate", "auth", "config", "unsupported-tools", "context-limit"]);
function defaultNormalize(note) {
  return String(note ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
function cwdInsideRoot(cwd, root, rootIdent) {
  if (!cwd || !root) return true;
  try {
    const frozen = path.resolve(root);
    const listing = fsSync.lstatSync(frozen);
    if (listing.isSymbolicLink() || !listing.isDirectory()) return false;
    if (rootIdent && rootIdent.dev != null && rootIdent.ino != null && (Number(listing.dev) !== Number(rootIdent.dev) || Number(listing.ino) !== Number(rootIdent.ino))) {
      return false;
    }
    const realCwd = fsSync.realpathSync(path.resolve(cwd));
    const rel = path.relative(frozen, realCwd);
    return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}
function errorCode(error) {
  if (!error) return "provider";
  if (typeof error.code === "string") return error.code;
  if (error.cause && typeof error.cause.code === "string") return error.cause.code;
  return "provider";
}
function mergeUsage(prev, next) {
  if (!next) return prev ?? { costUsd: "unknown" };
  const add = (key) => {
    const a = prev?.[key];
    const b = next[key];
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (typeof b === "number") return b;
    if (typeof a === "number") return a;
    return void 0;
  };
  const costs = [prev?.costUsd, next.costUsd];
  let costUsd = "unknown";
  if (costs.some((value) => value === "unknown")) costUsd = "unknown";
  else if (costs.every((value) => value == null)) costUsd = "unknown";
  else {
    const nums = costs.filter((value) => typeof value === "number");
    costUsd = nums.length ? nums.reduce((a, b) => a + b, 0) : "unknown";
  }
  return {
    inputTokens: add("inputTokens"),
    outputTokens: add("outputTokens"),
    totalTokens: add("totalTokens"),
    costUsd
  };
}
var DIRECT_PROVIDER_KINDS = /* @__PURE__ */ new Set(["api", "oauth"]);
var UNSUPPORTED_PROVIDER_MESSAGE = "saved CLI provider is no longer supported; run /cross-model-advisor:on to reconfigure";
function unsupportedProviderDiagnostic(provider) {
  const kind = provider && typeof provider.kind === "string" ? provider.kind : "";
  if (DIRECT_PROVIDER_KINDS.has(kind)) return null;
  return {
    available: false,
    error: { code: "config", message: UNSUPPORTED_PROVIDER_MESSAGE }
  };
}
function configRevisionOf(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function normalizeAdvisorSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  return {
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    instructions: spec.instructions,
    enabled: spec.enabled !== false,
    reasoningEffort: typeof spec.reasoningEffort === "string" ? spec.reasoningEffort : "default"
  };
}
function providerIdentity(provider) {
  if (!provider || typeof provider !== "object") return null;
  return {
    kind: provider.kind ?? "",
    provider: provider.provider ?? "",
    apiKeyEnv: typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : "",
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
    models: provider.models ?? null
  };
}
function advisorSpecKey(spec, exclude, provider) {
  const normalized = normalizeAdvisorSpec(spec);
  return JSON.stringify({
    provider: normalized?.provider ?? "",
    model: normalized?.model ?? "",
    instructions: normalized?.instructions ?? "",
    enabled: normalized?.enabled !== false,
    reasoningEffort: normalized?.reasoningEffort ?? "default",
    exclude: exclude ?? [],
    providerDef: providerIdentity(provider)
  });
}
function limitsIdentity(limits) {
  return JSON.stringify(limits ?? {});
}
function outputTokenLimit(limits) {
  const value = limits?.maxOutputTokens;
  return Number.isInteger(value) ? value : DEFAULT_MAX_OUTPUT_TOKENS;
}
function rootsEquivalent(left, right, rootIdent) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    if (fsSync.realpathSync(a) === fsSync.realpathSync(b)) return true;
  } catch {
  }
  if (rootIdent?.dev == null || rootIdent?.ino == null) return false;
  try {
    const listing = fsSync.lstatSync(b);
    return Number(listing.dev) === Number(rootIdent.dev) && Number(listing.ino) === Number(rootIdent.ino);
  } catch {
    return false;
  }
}
function apiKeyMissing(provider, env) {
  if (!provider || provider.kind !== "api") return false;
  const name = typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : "";
  if (!name) return true;
  const value = env?.[name];
  return typeof value !== "string" || value.trim().length === 0;
}
function diagnosticErrorText(diagnostic) {
  const err = diagnostic?.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err.message === "string" && err.message) return err.message;
  return "unavailable";
}
function credentialDirFromEnv(env, configFilePathFn) {
  return path.resolve(
    path.join(path.dirname(configFilePathFn(env)), "cross-model-advisor", "credentials")
  );
}
function pluginRootFromHere() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.basename(here);
  if (dir === "src" || dir === "dist") return path.dirname(here);
  if (dir === "modules") return path.dirname(path.dirname(here));
  return here;
}
function bundleStatus(pluginRoot) {
  const dist = path.join(pluginRoot, "dist");
  const need = ["control.mjs", "worker.mjs", "auth-control.mjs", "setup-control.mjs"];
  const missing = need.filter((name) => !fsSync.existsSync(path.join(dist, name)));
  return { ok: missing.length === 0, missing };
}
async function acquireLock(dir) {
  const lock = lockDir(dir);
  const ownerFile = path.join(lock, "owner.json");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await fs.mkdir(lock);
      await atomicWriteJson(ownerFile, { pid: process.pid, startedAt: Date.now() });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
      } catch {
        owner = null;
      }
      let locator = null;
      try {
        locator = JSON.parse(await fs.readFile(locatorPath(dir), "utf8"));
      } catch {
        locator = null;
      }
      const ownerLive = Boolean(owner?.pid && pidIsLive(owner.pid));
      const locatorLive = Boolean(
        locator?.pid && pidIsLive(locator.pid) && locator.socketPath && fsSync.existsSync(locator.socketPath)
      );
      if (ownerLive || locatorLive) return false;
      if (!owner && attempt < 15) {
        await wait(20);
        continue;
      }
      await fs.rm(lock, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  return false;
}
async function pruneSessions(pluginData, now, liveId) {
  const root = path.join(pluginData, "sessions");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === liveId) continue;
    const dir = path.join(root, entry.name);
    try {
      const raw = await fs.readFile(locatorPath(dir), "utf8");
      const locator = JSON.parse(raw);
      if (locator?.pid && pidIsLive(locator.pid)) continue;
    } catch {
    }
    let mtime = now;
    try {
      const stat = await fs.stat(dir);
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > SESSION_RETENTION_MS) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
}
async function resolveDeps(options) {
  let configMod = null;
  let toolsMod = null;
  let apiMod = null;
  let storeMod = null;
  let prompt = options.advisorSystemPrompt;
  if (!options.loadConfig || !options.validateRoot || !options.runtimeErrors || !options.configFilePath) {
    configMod = await import("./config.mjs");
  }
  if (!options.createReviewTools) {
    toolsMod = await import("./tools.mjs");
  }
  if (!options.validateApi || !options.reviewApi) {
    apiMod = await import("./backends/api.mjs");
  }
  if (!options.readConfigState) {
    try {
      storeMod = await import("./setup-store.mjs");
    } catch {
      storeMod = null;
    }
  }
  if (prompt == null) {
    prompt = (await import("./prompt.mjs")).advisorSystemPrompt;
  }
  return {
    loadConfig: options.loadConfig ?? configMod.loadConfig,
    validateRoot: options.validateRoot ?? configMod?.validateRoot ?? (async (value) => {
      if (!value) throw new Error("missing root");
      return value;
    }),
    snapshotRoot: options.snapshotRoot ?? configMod?.snapshotRoot,
    runtimeErrors: options.runtimeErrors ?? configMod?.runtimeErrors ?? (() => []),
    configFilePath: options.configFilePath ?? configMod.configFilePath,
    readConfigState: options.readConfigState ?? storeMod?.readConfigState,
    createReviewTools: options.createReviewTools ?? toolsMod?.createReviewTools,
    normalizeFinding: options.normalizeFinding ?? toolsMod?.normalizeFinding ?? defaultNormalize,
    validateApi: options.validateApi ?? apiMod?.validateApi,
    reviewApi: options.reviewApi ?? apiMod?.reviewApi,
    advisorSystemPrompt: prompt
  };
}
async function fileEvidenceFresh(evidence, root) {
  const maxBytes = 1024 * 1024;
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (item?.kind !== "file") continue;
    const abs = path.resolve(root, item.path);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    let handle;
    try {
      const st = await fs.lstat(abs);
      if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) return false;
      const flags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
      handle = await fs.open(abs, flags);
      const fdStat = await handle.stat();
      if (fdStat.ino !== st.ino || fdStat.dev !== st.dev || !fdStat.isFile()) return false;
      const buf = Buffer.alloc(Number(st.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const hash = crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex");
      if (hash !== item.hash) return false;
    } catch {
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {
      });
    }
  }
  return true;
}
async function startWorker(options) {
  try {
    process.umask(WORKER_UMASK);
  } catch {
  }
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sessionId = validateSessionId(options.sessionId);
  const projectRoot = options.projectRoot;
  const pluginData = options.pluginData;
  if (!pluginData) throw new Error("plugin data path required");
  const dir = sessionDirectory(pluginData, sessionId);
  await ensurePrivateDir(path.join(pluginData, "sessions"));
  await ensurePrivateDir(dir);
  const locked = await acquireLock(dir);
  if (!locked) {
    const error = new Error("worker already running");
    error.code = "worker-running";
    throw error;
  }
  const deps = await resolveDeps(options);
  let state = await loadState(dir);
  state.workerGeneration = (Number(state.workerGeneration) || 0) + 1;
  if (!state.projectRoot) state.projectRoot = projectRoot;
  if (!Array.isArray(state.issuance)) state.issuance = [];
  adoptLegacyIssuance(state.issuance, state.inbox);
  pruneIssuance(state.issuance);
  const socket = await createSocketDir();
  const controlCapability = randomCapability();
  const locator = {
    pid: process.pid,
    socketPath: socket.socketPath,
    controlCapability,
    workerGeneration: state.workerGeneration,
    startedAt: new Date(now()).toISOString()
  };
  const errors = createErrorLog(dir, {
    secrets: () => resolveSecrets(secretNamesFromSnapshot(state.activation), env),
    now
  });
  const reviews = /* @__PURE__ */ new Map();
  const recent = [];
  const toolIndex = /* @__PURE__ */ new Map();
  let debounceTimer = null;
  let idleTimer = null;
  let shuttingDown = false;
  let closed = false;
  let server = null;
  let persistChain = Promise.resolve();
  let stopPromise = null;
  const pendingWork = /* @__PURE__ */ new Set();
  const secrets = () => resolveSecrets(secretNamesFromSnapshot(state.activation), env);
  const writeState = typeof options.saveState === "function" ? options.saveState : saveState;
  const enqueuePersist = () => {
    const run = () => {
      if (closed) return;
      return writeState(dir, state);
    };
    persistChain = persistChain.then(run, run);
    return persistChain;
  };
  const persist = () => enqueuePersist().catch((error) => {
    if (!closed) errors.record(error);
  });
  const persistDurable = async () => {
    try {
      await enqueuePersist();
    } catch (error) {
      if (!closed) errors.record(error);
      throw error;
    }
  };
  const cancelPendingSchedule = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
  const trackWork = (promise) => {
    const work = Promise.resolve(promise);
    pendingWork.add(work);
    work.finally(() => pendingWork.delete(work));
    return work;
  };
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    if (shuttingDown || closed) return;
    const idleMs = options.idleMs ?? IDLE_EXIT_MS;
    if (!Number.isFinite(idleMs) || options.exitOnIdle === false) return;
    idleTimer = setTimeout(() => {
      const busy = [...state.activation?.advisors ?? []].some((advisor) => reviews.has(advisor.name));
      if (!busy && !shuttingDown) {
        stop({ reason: "idle" }).catch(() => {
        });
      }
    }, idleMs);
  };
  const rememberObservation = (obs) => {
    recent.push(obs);
    if (recent.length > 80) recent.splice(0, recent.length - 80);
    if (obs.toolUseId) {
      const prev = toolIndex.get(obs.toolUseId);
      if (prev) {
        const merged = mergeToolObservation(prev, obs);
        const idx = recent.indexOf(prev);
        if (idx >= 0) recent[idx] = merged;
        toolIndex.set(obs.toolUseId, merged);
        return merged;
      }
      toolIndex.set(obs.toolUseId, obs);
    }
    return obs;
  };
  const nextSeq = () => {
    state.observationSeq += 1;
    return state.observationSeq;
  };
  const ingestHook = (payload, phase) => {
    const key = dedupeKey({
      sessionId,
      generation: state.generation,
      promptId: payload.prompt_id,
      toolUseId: payload.tool_use_id,
      phase
    });
    if (seenDedupe(state.dedupe, key)) return null;
    state.dedupe = rememberDedupe(state.dedupe, key);
    const obs = observationFromHook(payload, {
      sessionId,
      generation: state.generation,
      seq: nextSeq(),
      root: state.projectRoot,
      secrets: secrets(),
      now: now()
    });
    return rememberObservation(obs);
  };
  const ingestTranscript = async (transcriptPath) => {
    if (!transcriptPath) return;
    state.transcriptPath = transcriptPath;
    const increment = await readTranscriptIncrement(transcriptPath, state.transcriptCursor);
    if (increment.gap) {
      rememberObservation({
        eventId: `gap_${nextSeq()}`,
        seq: state.observationSeq,
        sessionId,
        generation: state.generation,
        phase: "gap",
        gap: increment.gap.reason,
        at: now()
      });
    }
    const hookToolIds = new Set(recent.map((item) => item.toolUseId).filter(Boolean));
    const controlPromptIds = new Set(state.controlPromptIds);
    let newestUser = null;
    for (const record of increment.records) {
      const interpreted = interpretRecord(record, {
        secrets: secrets(),
        hookToolIds,
        controlPromptIds
      });
      const uuidKey = interpreted.uuid ? dedupeKey({ sessionId, generation: state.generation, uuid: interpreted.uuid }) : null;
      if (uuidKey && seenDedupe(state.dedupe, uuidKey)) continue;
      if (uuidKey) state.dedupe = rememberDedupe(state.dedupe, uuidKey);
      if (interpreted.kind === "compact") {
        if (!state.compactSummary || (state.compactSummary.at ?? 0) <= now()) {
          state.compactSummary = {
            text: interpreted.text,
            at: now(),
            generation: state.generation,
            promptId: null
          };
        }
        continue;
      }
      if (interpreted.kind === "user" && interpreted.text) {
        newestUser = {
          text: interpreted.text,
          promptId: interpreted.promptId,
          at: now(),
          generation: state.generation
        };
      }
      const obs = observationFromTranscript(interpreted, {
        sessionId,
        generation: state.generation,
        seq: nextSeq(),
        now: now()
      });
      if (obs) rememberObservation(obs);
    }
    state.transcriptCursor = increment.cursor;
    if (!state.latestTask) {
      const recovered = newestUser ?? recoverLatestTask(increment.records, {
        secrets: secrets(),
        controlPromptIds
      });
      if (recovered?.text) {
        state.latestTask = {
          text: recovered.text,
          promptId: recovered.promptId ?? null,
          at: now(),
          generation: state.generation
        };
        state.contextUnavailable = false;
      }
    }
  };
  const advisorRecord = (name) => {
    if (!state.advisors[name]) {
      state.advisors[name] = {
        name,
        reviews: 0,
        consecutiveFailures: 0,
        paused: false,
        pauseReason: null,
        lastError: null,
        usage: null,
        fingerprints: [],
        cursor: 0,
        history: [],
        coalesced: null,
        epoch: 1,
        tombstone: false,
        identity: null,
        enabled: true,
        reasoningEffort: "default"
      };
    }
    const rec = state.advisors[name];
    if (!Array.isArray(rec.history)) rec.history = [];
    if (!(Number(rec.epoch) > 0)) rec.epoch = 1;
    if (rec.tombstone == null) rec.tombstone = false;
    return rec;
  };
  const cancelReview = (name, reason) => {
    const active = reviews.get(name);
    if (!active) return 0;
    active.reason = reason;
    try {
      active.abort.abort({ code: reason === "timeout" ? "timeout" : "cancel" });
    } catch {
      active.abort.abort();
    }
    reviews.delete(name);
    const rec = advisorRecord(name);
    rec.coalesced = null;
    return 1;
  };
  const cancelAll = (reason) => {
    let n = 0;
    for (const name of [...reviews.keys()]) n += cancelReview(name, reason);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return n;
  };
  const pauseAdvisor = (name, code, message) => {
    const rec = advisorRecord(name);
    rec.paused = true;
    rec.pauseReason = code;
    rec.lastError = sanitizeText(message ?? code, secrets());
  };
  const publicationAllowed = (reserved) => {
    if (!reserved) return false;
    if (reserved.abort?.signal?.aborted) return false;
    if (!state.enabled || state.pauseReason === "off") return false;
    if (reserved.generation !== state.generation) return false;
    if (state.compaction?.phase === "pre") return false;
    const rec = advisorRecord(reserved.name ?? "");
    if (!rec || rec.tombstone) return false;
    if (reserved.epoch != null && rec.epoch !== reserved.epoch) return false;
    if (reserved.promptId && state.latestTask?.promptId && reserved.promptId !== state.latestTask.promptId) {
      return false;
    }
    return true;
  };
  const publishCandidate = async (name, tools, meta, reserved) => {
    if (!publicationAllowed(reserved)) return null;
    const candidate = typeof tools.candidate === "function" ? tools.candidate : tools.candidate;
    const value = typeof candidate === "function" ? candidate() : candidate;
    if (!value) return null;
    const rec = advisorRecord(name);
    if (reserved?.epoch != null && rec.epoch !== reserved.epoch) return null;
    const fp = deps.normalizeFinding(value.note);
    if (fp && rec.fingerprints.includes(fp)) return null;
    const fresh = typeof tools.isFresh === "function" ? await tools.isFresh(value.evidence) : true;
    if (!publicationAllowed(reserved)) return null;
    if (reserved?.epoch != null && rec.epoch !== reserved.epoch) return null;
    if (!fresh) return null;
    const sanitized = {
      ...value,
      note: sanitizeText(String(value.note ?? ""), secrets()),
      evidence: (value.evidence ?? []).map((item) => ({
        ...item,
        detail: sanitizeText(String(item?.detail ?? ""), secrets())
      }))
    };
    if (fp) {
      rec.fingerprints = [...rec.fingerprints, fp].slice(-4096);
    }
    const finding = acceptedFinding(sanitized, {
      ...meta,
      epoch: reserved?.epoch ?? rec.epoch,
      settingsRevision: state.settingsRevision ?? 0
    });
    state.inbox.push(finding);
    return finding;
  };
  const startReview = async (advisorSpec, observations) => {
    if (shuttingDown || closed) return;
    if (advisorSpec?.enabled === false) return;
    const rec = advisorRecord(advisorSpec.name);
    if (rec.paused || rec.tombstone || reviews.has(advisorSpec.name)) return;
    if (!state.latestTask && !state.compactSummary) {
      state.contextUnavailable = true;
      return;
    }
    const current = { latestTask: state.latestTask, compactSummary: state.compactSummary, observations };
    if (!currentContextFits(current)) {
      pauseAdvisor(advisorSpec.name, "context-limit", "required current context cannot fit");
      await persist();
      return;
    }
    const bounded = boundHistory(rec.history ?? [], { required: current });
    if (!bounded.fit) {
      pauseAdvisor(advisorSpec.name, "context-limit", "required current context cannot fit");
      await persist();
      return;
    }
    const limits = state.activation?.limits ?? {};
    const maxReviews = limits.maxReviewsPerAdvisorPerSession ?? DEFAULT_MAX_REVIEWS;
    if ((rec.reviews ?? 0) >= maxReviews) {
      pauseAdvisor(advisorSpec.name, "session-limit", "per-advisor session review limit reached");
      await persist();
      return;
    }
    const reviewId = randomId("rev");
    const abort = new AbortController();
    const reservedGeneration = state.generation;
    const reservedPromptId = state.latestTask?.promptId ?? null;
    const reservedEpoch = rec.epoch;
    const timeoutMs = (limits.reviewTimeoutSeconds ?? DEFAULT_REVIEW_TIMEOUT_MS / 1e3) * 1e3;
    const timer = setTimeout(() => {
      try {
        abort.abort({ code: "timeout" });
      } catch {
        abort.abort();
      }
    }, timeoutMs);
    const reserved = {
      reviewId,
      abort,
      generation: reservedGeneration,
      promptId: reservedPromptId,
      timer,
      epoch: reservedEpoch,
      name: advisorSpec.name
    };
    reviews.set(advisorSpec.name, reserved);
    rec.reviews = (rec.reviews ?? 0) + 1;
    const provider = state.activation.providers[advisorSpec.provider];
    const blocked = unsupportedProviderDiagnostic(provider);
    if (blocked) {
      clearTimeout(timer);
      if (reviews.get(advisorSpec.name)?.reviewId === reviewId) reviews.delete(advisorSpec.name);
      rec.reviews = Math.max(0, (rec.reviews ?? 1) - 1);
      pauseAdvisor(advisorSpec.name, blocked.error.code, blocked.error.message);
      await persist();
      return;
    }
    const ownsReview = () => {
      const still = reviews.get(advisorSpec.name);
      return still?.reviewId === reviewId && still?.epoch === reservedEpoch;
    };
    const epochCurrent = () => advisorRecord(advisorSpec.name).epoch === reservedEpoch;
    trackWork(
      (async () => {
        let tools;
        try {
          tools = await deps.createReviewTools({
            root: state.projectRoot,
            rootIdent: state.rootIdent,
            exclude: state.activation.exclude ?? [],
            observations,
            advisor: advisorSpec,
            signal: abort.signal,
            pluginData,
            credentialDir: credentialDirFromEnv(env, deps.configFilePath),
            secrets: secrets(),
            fingerprints: rec.fingerprints
          });
        } catch (error) {
          clearTimeout(timer);
          if (ownsReview()) reviews.delete(advisorSpec.name);
          await errors.record(error);
          return;
        }
        if (shuttingDown || !publicationAllowed(reserved) || !ownsReview()) {
          clearTimeout(timer);
          if (ownsReview()) reviews.delete(advisorSpec.name);
          try {
            abort.abort({ code: "cancel" });
          } catch {
            abort.abort();
          }
          return;
        }
        await persist();
        const systemPrompt = `${deps.advisorSystemPrompt}

${advisorSpec.instructions ?? ""}`.trim();
        const reviewLimits = {
          maxToolCallsPerReview: limits.maxToolCallsPerReview,
          maxOutputTokens: limits.maxOutputTokens,
          reviewTimeoutSeconds: limits.reviewTimeoutSeconds
        };
        const args = {
          provider,
          advisor: advisorSpec,
          observations,
          history: bounded.history,
          latestTask: state.latestTask,
          compactSummary: state.compactSummary,
          currentContext: current,
          systemPrompt,
          tools,
          limits: reviewLimits,
          signal: abort.signal,
          env
        };
        try {
          const result = await deps.reviewApi(args);
          clearTimeout(timer);
          if (result?.usage) rec.usage = mergeUsage(rec.usage, result.usage);
          if (!publicationAllowed(reserved) || !ownsReview() || !epochCurrent()) return;
          rec.history = result?.history ?? bounded.history;
          rec.consecutiveFailures = 0;
          rec.lastError = null;
          await publishCandidate(
            advisorSpec.name,
            tools,
            {
              advisor: advisorSpec.name,
              provider: advisorSpec.provider,
              model: advisorSpec.model,
              kind: provider.kind,
              sourcePromptId: reservedPromptId,
              generation: reservedGeneration,
              epoch: reservedEpoch,
              observationRange: observations.length ? { from: observations[0].seq, to: observations[observations.length - 1].seq } : null,
              now: now()
            },
            reserved
          );
        } catch (error) {
          clearTimeout(timer);
          if (error?.usage) rec.usage = mergeUsage(rec.usage, error.usage);
          if (!epochCurrent()) return;
          const code = errorCode(error);
          rec.lastError = sanitizeText(error?.message ?? code, secrets());
          if (PAUSE_IMMEDIATE.has(code)) {
            pauseAdvisor(advisorSpec.name, code, rec.lastError);
          } else if (code === "provider") {
            rec.consecutiveFailures = (rec.consecutiveFailures ?? 0) + 1;
            if (rec.consecutiveFailures >= 3) {
              pauseAdvisor(advisorSpec.name, "provider", rec.lastError);
            }
          }
        } finally {
          clearTimeout(timer);
          if (ownsReview()) reviews.delete(advisorSpec.name);
          if (epochCurrent()) rec.cursor = state.observationSeq;
          await persist();
          if (epochCurrent() && rec.coalesced && state.enabled && !state.paused && !state.primaryIdle && !rec.paused && !rec.tombstone && !shuttingDown) {
            const next = rec.coalesced;
            rec.coalesced = null;
            await startReview(advisorSpec, next);
          }
          bumpIdle();
        }
      })()
    );
  };
  const schedule = () => {
    if (shuttingDown || closed || state.primaryIdle) return;
    clearTimeout(debounceTimer);
    const wait = options.debounceMs ?? DEBOUNCE_MS;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (shuttingDown || closed) return;
      runSerial(() => launchDue()).catch((error) => errors.record(error));
    }, wait);
  };
  const launchDue = async () => {
    if (shuttingDown || closed || !state.enabled || state.paused || state.primaryIdle || state.contextUnavailable || state.cwdOutsideRoot) {
      return;
    }
    if (state.compaction?.phase === "pre") return;
    const specs = (state.activation?.advisors ?? []).filter((spec) => {
      if (spec.enabled === false) return false;
      const rec = advisorRecord(spec.name);
      return !rec.paused && !rec.tombstone;
    });
    const maxConcurrent = state.activation?.limits?.maxConcurrentAdvisors ?? DEFAULT_MAX_CONCURRENT;
    let busy = [...reviews.keys()].length;
    const observations = recent.filter((item) => item.generation === state.generation).slice(-40);
    for (const spec of specs) {
      const rec = advisorRecord(spec.name);
      if (reviews.has(spec.name) || busy >= maxConcurrent) {
        rec.coalesced = observations;
        continue;
      }
      busy += 1;
      await startReview(spec, observations);
    }
  };
  const maybeClearBlockedCompact = (payload) => {
    if (state.compaction?.phase !== "pre") return;
    if (payload?.compact_summary) return;
    state.compaction = null;
    state.paused = false;
    if (state.pauseReason === "compaction") state.pauseReason = null;
  };
  let hookClient = null;
  const drain = async (eventName, { allow } = {}) => {
    const issuer = normalizeClient(hookClient);
    if (!allow) return { stdout: "", claimId: null, client: issuer };
    const claimed = await claimFindings(state.inbox, {
      now: now(),
      leaseMs: options.claimLeaseMs ?? CLAIM_LEASE_MS,
      isFresh: (finding) => fileEvidenceFresh(finding.evidence, state.projectRoot),
      isEligible: (finding) => findingEligible(finding, state),
      client: issuer
    });
    if (claimed.claimId) {
      recordIssuance(state.issuance, {
        claimId: claimed.claimId,
        client: issuer,
        findings: claimed.findings,
        now: now()
      });
      try {
        await persistDurable();
      } catch {
        releaseClaim(state.inbox, claimed.claimId);
        clearIssuance(state.issuance, claimed.claimId);
        return { stdout: "", claimId: null, client: issuer };
      }
    } else {
      await persist();
    }
    if (!claimed.claimId) return { stdout: "", claimId: null, client: issuer };
    const additionalContext = claimed.envelopes.join("\n\n");
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext
        }
      })}
`,
      claimId: claimed.claimId,
      client: issuer
    };
  };
  const handleSessionStart = async (payload) => {
    const source = payload.source ?? "startup";
    state.transcriptPath = payload.transcript_path ?? state.transcriptPath;
    if (payload.cwd && state.projectRoot && !cwdInsideRoot(payload.cwd, state.projectRoot, state.rootIdent)) {
      state.cwdOutsideRoot = true;
      state.paused = true;
      state.pauseReason = "cwd-outside-root";
      cancelAll("cwd");
    }
    if (source === "compact") {
      if (state.compaction?.phase === "done") return { stdout: "" };
      const recovered = typeof payload.compact_summary === "string" ? payload.compact_summary : state.transcriptPath ? recoverCompactSummary((await readTranscriptIncrement(state.transcriptPath, { offset: 0 })).records, secrets()) : null;
      if (recovered) {
        const summary = truncateLabeled(sanitizeText(recovered, secrets()), USER_TEXT_CAP);
        if (!state.latestTask || (state.latestTask.at ?? 0) <= (state.compaction?.at ?? 0)) {
          state.compactSummary = { text: summary, at: now(), generation: state.generation, promptId: null };
        }
        if (state.compaction?.phase === "pre") {
          state.generation += 1;
          state.compaction = {
            phase: "done",
            priorGeneration: state.generation - 1,
            observationBoundary: state.observationSeq,
            summaryIdentity: fingerprintSnapshot(summary),
            at: now()
          };
          for (const rec of Object.values(state.advisors)) rec.history = [];
          retainPreCompact(state.inbox, state.generation);
        }
        state.paused = false;
        if (state.pauseReason === "compaction") state.pauseReason = null;
        state.contextUnavailable = false;
      } else if (state.compaction?.phase !== "done") {
        state.contextUnavailable = true;
        state.pauseReason = "context-unavailable";
      }
      return { stdout: "" };
    }
    const nextSettings = (Number(state.settingsRevision) || 0) + 1;
    state.enabled = false;
    state.ended = false;
    cancelAll("session-start");
    if (source === "fork") {
      state = emptyState({
        projectRoot: state.projectRoot,
        workerGeneration: state.workerGeneration,
        transcriptPath: payload.transcript_path ?? null,
        settingsRevision: nextSettings
      });
    } else {
      state.settingsRevision = nextSettings;
    }
    if (source === "clear") {
      recent.length = 0;
      toolIndex.clear();
      state.latestTask = null;
      state.compactSummary = null;
      state.contextUnavailable = true;
    }
    return { stdout: "" };
  };
  const handlePrompt = async (payload) => {
    const classified = classifyPrompt(payload.prompt ?? "");
    if (classified.kind === "control") {
      if (payload.prompt_id) {
        state.controlPromptIds = [...state.controlPromptIds, payload.prompt_id].slice(-512);
      }
      cancelPendingSchedule();
      if (classified.command.endsWith(":off")) await handleOff();
      return { stdout: "", claimId: null };
    }
    if (classified.kind === "slash") {
      return { stdout: "", claimId: null };
    }
    maybeClearBlockedCompact(payload);
    if (payload.cwd && state.projectRoot && !cwdInsideRoot(payload.cwd, state.projectRoot, state.rootIdent)) {
      state.cwdOutsideRoot = true;
      state.paused = true;
      state.pauseReason = "cwd-outside-root";
      cancelAll("cwd");
      return { stdout: "", claimId: null };
    }
    state.primaryIdle = false;
    cancelAll("new-prompt");
    const text = truncateLabeled(sanitizeText(classified.rest || payload.prompt || "", secrets()), USER_TEXT_CAP);
    state.latestTask = {
      text,
      promptId: payload.prompt_id ?? null,
      at: now(),
      generation: state.generation
    };
    state.contextUnavailable = !text;
    ingestHook(payload, "prompt");
    const drained = await drain("UserPromptSubmit", { allow: DRAIN_EVENTS.includes("UserPromptSubmit") });
    if (state.enabled && !state.paused && !state.contextUnavailable && !state.cwdOutsideRoot) {
      schedule();
    }
    return drained;
  };
  const handleExpansion = async (payload) => {
    const classified = classifyExpansion(payload);
    if (classified.kind === "control") {
      if (payload.prompt_id) {
        state.controlPromptIds = [...state.controlPromptIds, payload.prompt_id].slice(-512);
      }
      cancelPendingSchedule();
      if (classified.command.endsWith(":off")) await handleOff();
      return { stdout: "" };
    }
    maybeClearBlockedCompact(payload);
    if (classified.kind === "slash" || classified.kind === "task") {
      state.primaryIdle = false;
      cancelAll("new-prompt");
      const text = truncateLabeled(
        sanitizeText(classified.rest || payload.prompt || "", secrets()),
        USER_TEXT_CAP
      );
      if (text) {
        state.latestTask = {
          text,
          promptId: payload.prompt_id ?? null,
          at: now(),
          generation: state.generation
        };
        state.contextUnavailable = false;
      }
      ingestHook(
        { ...payload, prompt: classified.rest || payload.prompt, hook_event_name: "UserPromptExpansion" },
        "prompt"
      );
      if (state.enabled && !state.paused && !state.contextUnavailable) schedule();
    }
    return { stdout: "" };
  };
  const handleTool = async (payload, phase) => {
    if (payload.prompt_id && state.controlPromptIds.includes(payload.prompt_id)) {
      return { stdout: "" };
    }
    maybeClearBlockedCompact(payload);
    ingestHook(payload, phase);
    const event = payload.hook_event_name;
    const drained = await drain(event, { allow: DRAIN_EVENTS.includes(event) });
    if (state.enabled && !state.paused && !state.primaryIdle && !state.contextUnavailable) {
      schedule();
    }
    return drained;
  };
  const handleStop = async (payload) => {
    ingestHook(payload, "stop");
    state.primaryIdle = true;
    cancelPendingSchedule();
    for (const rec of Object.values(state.advisors)) rec.coalesced = null;
    return { stdout: "" };
  };
  const handleStopFailure = async (payload) => {
    ingestHook(payload, "stop-failure");
    state.primaryIdle = true;
    cancelAll("stop-failure");
    return { stdout: "" };
  };
  const handlePreCompact = async () => {
    cancelAll("compact");
    state.paused = true;
    state.pauseReason = "compaction";
    state.compaction = {
      phase: "pre",
      priorGeneration: state.generation,
      observationBoundary: state.observationSeq,
      summaryIdentity: null,
      at: now()
    };
    await persist();
    return { stdout: "" };
  };
  const handlePostCompact = async (payload) => {
    const summary = typeof payload.compact_summary === "string" ? payload.compact_summary : "";
    const identity = fingerprintSnapshot(summary);
    if (state.compaction?.phase === "done" && state.compaction.summaryIdentity === identity) {
      return { stdout: "" };
    }
    const alreadyAdvanced = state.compaction?.phase === "done";
    if (!alreadyAdvanced) {
      const prior = state.generation;
      state.generation += 1;
      state.compaction = {
        phase: "done",
        priorGeneration: prior,
        observationBoundary: state.observationSeq,
        summaryIdentity: identity,
        at: now()
      };
      for (const rec of Object.values(state.advisors)) rec.history = [];
      retainPreCompact(state.inbox, state.generation);
    }
    if (summary) {
      const bounded = truncateLabeled(sanitizeText(summary, secrets()), USER_TEXT_CAP);
      const summaryAt = now();
      if (!state.latestTask || (state.latestTask.at ?? 0) <= (state.compaction.at ?? summaryAt)) {
        state.compactSummary = {
          text: bounded,
          at: summaryAt,
          generation: state.generation,
          promptId: null
        };
      }
      state.contextUnavailable = false;
    }
    state.paused = false;
    if (state.pauseReason === "compaction") state.pauseReason = null;
    await persist();
    return { stdout: "" };
  };
  const handleSessionEnd = async () => {
    state.ended = true;
    state.settingsRevision = (Number(state.settingsRevision) || 0) + 1;
    shuttingDown = true;
    cancelAll("session-end");
    await persist();
    setImmediate(() => {
      stop({ reason: "session-end" }).catch(() => {
      });
    });
    return { stdout: "" };
  };
  const configPathOf = () => {
    try {
      return typeof deps.configFilePath === "function" ? deps.configFilePath(env) : null;
    } catch {
      return null;
    }
  };
  const settingsAdvisors = () => (state.activation?.advisors ?? []).filter((spec) => !state.advisors[spec.name]?.tombstone).map((spec) => {
    const rec = advisorRecord(spec.name);
    const provider = state.activation?.providers?.[spec.provider];
    const enabled = spec.enabled !== false;
    const available = Boolean(enabled && !rec.paused);
    return {
      name: spec.name,
      enabled,
      available,
      provider: spec.provider,
      model: spec.model,
      kind: provider?.kind ?? rec.kind,
      reasoningEffort: spec.reasoningEffort ?? rec.reasoningEffort ?? "default",
      error: available ? void 0 : rec.lastError ?? void 0
    };
  });
  const settingsSnapshot = () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    projectRoot: state.projectRoot ?? null,
    configPath: configPathOf(),
    workerGeneration: state.workerGeneration,
    settingsRevision: Number(state.settingsRevision) || 0,
    enabled: Boolean(state.enabled),
    paused: Boolean(state.paused),
    advisors: settingsAdvisors()
  });
  const settingsFail = (code) => ({
    ok: false,
    error: code,
    code,
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    projectRoot: state.projectRoot ?? null,
    configPath: configPathOf(),
    workerGeneration: state.workerGeneration,
    settingsRevision: Number(state.settingsRevision) || 0,
    enabled: Boolean(state.enabled),
    paused: Boolean(state.paused),
    advisors: settingsAdvisors()
  });
  const affectedAdvisorNames = (nextSpecs, nextExclude, nextProviders, nextLimits) => {
    const oldSpecs = state.activation?.advisors ?? [];
    const oldExclude = state.activation?.exclude ?? [];
    const oldProviders = state.activation?.providers ?? {};
    const oldLimits = state.activation?.limits ?? {};
    const nextNames = new Set(nextSpecs.map((spec) => spec.name));
    const affected = /* @__PURE__ */ new Set();
    const excludeChanged = JSON.stringify(oldExclude) !== JSON.stringify(nextExclude ?? []);
    const limitsChanged = limitsIdentity(oldLimits) !== limitsIdentity(nextLimits ?? {});
    if (excludeChanged || limitsChanged) {
      for (const spec of oldSpecs) affected.add(spec.name);
      for (const spec of nextSpecs) affected.add(spec.name);
      return affected;
    }
    const oldByName = new Map(oldSpecs.map((spec) => [spec.name, spec]));
    for (const spec of oldSpecs) {
      if (!nextNames.has(spec.name)) affected.add(spec.name);
    }
    for (const spec of nextSpecs) {
      const prev = oldByName.get(spec.name);
      const prevKey = prev ? advisorSpecKey(prev, oldExclude, oldProviders?.[prev.provider]) : null;
      const nextKey = advisorSpecKey(spec, nextExclude ?? [], nextProviders?.[spec.provider]);
      if (!prev || prevKey !== nextKey) affected.add(spec.name);
    }
    return affected;
  };
  const fenceAffected = (affected) => {
    for (const name of affected) {
      cancelReview(name, "settings");
      const rec = advisorRecord(name);
      rec.epoch = (Number(rec.epoch) > 0 ? Number(rec.epoch) : 1) + 1;
      rec.coalesced = null;
      rec.history = [];
    }
    fenceAdvisorFindings(state.inbox, affected);
  };
  const diagnoseAdvisors = async (config) => {
    const advisors = [];
    const maxOutputTokens = outputTokenLimit(config?.limits);
    for (const advisor of (config.advisors ?? []).map(normalizeAdvisorSpec)) {
      const provider = config.providers?.[advisor.provider];
      if (advisor.enabled === false) {
        advisors.push({
          name: advisor.name,
          enabled: false,
          available: false,
          provider: advisor.provider,
          model: advisor.model,
          kind: provider?.kind,
          reasoningEffort: advisor.reasoningEffort,
          error: void 0
        });
        continue;
      }
      if (!provider) {
        advisors.push({
          name: advisor.name,
          enabled: true,
          available: false,
          provider: advisor.provider,
          model: advisor.model,
          reasoningEffort: advisor.reasoningEffort,
          error: "missing provider"
        });
        continue;
      }
      const diagnostic = unsupportedProviderDiagnostic(provider) ?? await deps.validateApi({ provider, advisor, env, maxOutputTokens });
      const available = Boolean(diagnostic?.available);
      const reasoningInvalid = diagnostic?.reasoningInvalid === true;
      advisors.push({
        name: advisor.name,
        enabled: true,
        available,
        provider: advisor.provider,
        model: advisor.model,
        kind: provider.kind,
        reasoningEffort: advisor.reasoningEffort,
        error: available ? void 0 : sanitizeText(diagnosticErrorText(diagnostic), secrets()),
        reasoningInvalid: reasoningInvalid || void 0
      });
    }
    return advisors;
  };
  const readConfigExact = async () => {
    if (typeof deps.readConfigState === "function") {
      return deps.readConfigState({ env });
    }
    const file = typeof deps.configFilePath === "function" ? deps.configFilePath(env) : null;
    if (!file) return { path: null, revision: null, config: null, configError: "config unavailable" };
    let raw;
    try {
      raw = await fs.readFile(file);
    } catch {
      return { path: file, revision: null, config: null, configError: "config unavailable" };
    }
    const revision = configRevisionOf(raw);
    let config = null;
    let configError = null;
    try {
      config = await deps.loadConfig({ env });
    } catch (error) {
      configError = error instanceof Error ? error.message : "invalid config";
    }
    return { path: file, revision, config, configError };
  };
  const activateFromConfig = async ({ config, revision, wantEnabled, mode, frozenRoot, rootIdent }) => {
    const deny = (code, extra) => mode === "apply" ? settingsFail(code) : {
      ok: false,
      enabled: Boolean(state.enabled),
      error: code,
      code,
      advisors: extra?.advisors ?? []
    };
    if (shuttingDown || closed || state.ended) return deny(SETTINGS_ERRORS.STALE);
    const specs = (config.advisors ?? []).map(normalizeAdvisorSpec);
    const exclude = config.exclude ?? [];
    const affected = affectedAdvisorNames(specs, exclude, config.providers, config.limits);
    pruneIssuance(state.issuance);
    const blocked = ownershipDenyCode(state, affected);
    if (blocked) return deny(blocked);
    const diagnosed = await diagnoseAdvisors(config);
    if (shuttingDown || closed || state.ended) return deny(SETTINGS_ERRORS.STALE);
    pruneIssuance(state.issuance);
    const blockedAfter = ownershipDenyCode(state, affected);
    if (blockedAfter) return deny(blockedAfter);
    if (diagnosed.some((row) => row.reasoningInvalid)) {
      return deny(SETTINGS_ERRORS.CONFIG, { advisors: diagnosed });
    }
    if (shuttingDown || closed || state.ended) return deny(SETTINGS_ERRORS.STALE);
    const priorAdvisors = new Map(
      Object.entries(state.advisors ?? {}).map(([name, rec]) => [name, { ...rec }])
    );
    const priorInboxDeliverable = (state.inbox ?? []).map((item) => item.deliverable);
    const prior = {
      activation: state.activation,
      activationFingerprint: state.activationFingerprint,
      settingsRevision: state.settingsRevision,
      enabled: state.enabled,
      paused: state.paused,
      pauseReason: state.pauseReason,
      projectRoot: state.projectRoot,
      rootIdent: state.rootIdent,
      cwdOutsideRoot: state.cwdOutsideRoot
    };
    const restoreActivation = () => {
      state.activation = prior.activation;
      state.activationFingerprint = prior.activationFingerprint;
      state.settingsRevision = prior.settingsRevision;
      state.enabled = prior.enabled;
      state.paused = prior.paused;
      state.pauseReason = prior.pauseReason;
      state.projectRoot = prior.projectRoot;
      state.rootIdent = prior.rootIdent;
      state.cwdOutsideRoot = prior.cwdOutsideRoot;
      for (const name of Object.keys(state.advisors ?? {})) {
        if (!priorAdvisors.has(name)) delete state.advisors[name];
      }
      for (const [name, rec] of priorAdvisors) state.advisors[name] = rec;
      priorInboxDeliverable.forEach((flag, index) => {
        if (state.inbox[index]) state.inbox[index].deliverable = flag;
      });
    };
    const nextNames = new Set(specs.map((spec) => spec.name));
    fenceAffected(affected);
    for (const spec of state.activation?.advisors ?? []) {
      if (!nextNames.has(spec.name)) {
        const rec = advisorRecord(spec.name);
        rec.tombstone = true;
        rec.enabled = false;
      }
    }
    for (const row of diagnosed) {
      const rec = advisorRecord(row.name);
      rec.tombstone = false;
      rec.provider = row.provider;
      rec.model = row.model;
      rec.kind = row.kind;
      rec.enabled = row.enabled !== false;
      rec.reasoningEffort = row.reasoningEffort ?? "default";
      rec.identity = advisorSpecKey(
        specs.find((spec) => spec.name === row.name),
        exclude,
        config.providers?.[row.provider]
      );
      if (row.enabled === false) {
        rec.paused = false;
        continue;
      }
      if (row.available) {
        if (mode === "on" || affected.has(row.name)) {
          rec.paused = false;
          rec.pauseReason = null;
          rec.lastError = null;
          rec.consecutiveFailures = 0;
        }
      } else {
        rec.paused = true;
        rec.pauseReason = "unavailable";
        rec.lastError = row.error;
      }
    }
    state.activation = {
      version: config.version,
      providers: config.providers,
      advisors: specs,
      exclude,
      limits: config.limits ?? {},
      configRevision: revision ?? null
    };
    state.activationFingerprint = fingerprintSnapshot(state.activation);
    if (frozenRoot) {
      state.projectRoot = frozenRoot;
      if (rootIdent) state.rootIdent = rootIdent;
    }
    if (mode === "on") state.cwdOutsideRoot = false;
    const usable = diagnosed.filter((item) => item.available);
    if (wantEnabled) {
      state.enabled = usable.length > 0;
      if (state.compaction?.phase !== "pre" && !state.cwdOutsideRoot) {
        state.paused = !state.enabled;
        state.pauseReason = state.enabled ? null : "no-usable-advisors";
      }
    } else {
      state.enabled = false;
      if (state.pauseReason !== "cwd-outside-root" && state.compaction?.phase !== "pre") {
        state.paused = true;
        state.pauseReason = "off";
      }
    }
    state.settingsRevision = (Number(state.settingsRevision) || 0) + 1;
    try {
      await persistDurable();
    } catch {
      restoreActivation();
      return deny(SETTINGS_ERRORS.CONFIG);
    }
    return { diagnosed, usable };
  };
  const prepareActivationRoot = async () => {
    const runtime = deps.runtimeErrors({ env }) ?? [];
    if (runtime.length) {
      return { ok: false, reason: "runtime", error: runtime[0] };
    }
    let frozenRoot = projectRoot;
    let rootIdent = null;
    try {
      if (typeof deps.snapshotRoot === "function") {
        rootIdent = await deps.snapshotRoot(projectRoot);
        if (rootIdent?.path) frozenRoot = rootIdent.path;
      } else {
        const canonical = await deps.validateRoot(projectRoot);
        frozenRoot = typeof canonical === "string" && canonical ? canonical : projectRoot;
      }
    } catch (error) {
      return {
        ok: false,
        reason: "root",
        error: sanitizeText(error instanceof Error ? error.message : "invalid root", secrets())
      };
    }
    if (state.rootIdent?.dev != null && state.rootIdent?.ino != null && rootIdent?.dev != null && rootIdent?.ino != null && (Number(state.rootIdent.dev) !== Number(rootIdent.dev) || Number(state.rootIdent.ino) !== Number(rootIdent.ino))) {
      return { ok: false, reason: "root", error: SETTINGS_ERRORS.ROOT };
    }
    if (state.projectRoot && projectRoot && !rootsEquivalent(state.projectRoot, projectRoot, state.rootIdent ?? rootIdent)) {
      return { ok: false, reason: "root", error: SETTINGS_ERRORS.ROOT };
    }
    if (state.rootIdent) {
      rootIdent = state.rootIdent;
      if (state.projectRoot) frozenRoot = state.projectRoot;
    }
    return { ok: true, frozenRoot, rootIdent };
  };
  const handleOn = async () => {
    const prepared = await prepareActivationRoot();
    if (!prepared.ok) {
      return { ok: false, enabled: false, error: prepared.error, advisors: [] };
    }
    const { frozenRoot, rootIdent } = prepared;
    let config;
    try {
      config = await deps.loadConfig({ env, projectRoot: frozenRoot });
    } catch (error) {
      return {
        ok: false,
        enabled: false,
        error: sanitizeText(error instanceof Error ? error.message : "invalid config", secrets()),
        advisors: []
      };
    }
    const result = await activateFromConfig({
      config,
      revision: null,
      wantEnabled: true,
      mode: "on",
      frozenRoot,
      rootIdent
    });
    if (result?.ok === false) {
      return { ok: false, enabled: result.enabled, error: result.error, advisors: result.advisors ?? [] };
    }
    return {
      ok: true,
      enabled: state.enabled,
      projectRoot: state.projectRoot,
      advisors: result.diagnosed,
      limits: state.activation.limits,
      disclosure: "External providers receive bounded session observations. The plugin does not persist provider conversations. Injection is best-effort and never wakes a stopped session."
    };
  };
  const handleOff = async () => {
    const cancelled = cancelAll("off");
    discardInjectable(state.inbox);
    state.enabled = false;
    state.paused = true;
    state.pauseReason = "off";
    state.settingsRevision = (Number(state.settingsRevision) || 0) + 1;
    await persist();
    return {
      ok: true,
      enabled: false,
      cancelled,
      inboxRetained: state.inbox.length
    };
  };
  const handleStatus = async () => {
    const advisors = (state.activation?.advisors ?? []).map((spec) => {
      const rec = advisorRecord(spec.name);
      const provider = state.activation?.providers?.[spec.provider];
      let advisorState = "idle";
      if (!state.enabled || spec.enabled === false) advisorState = "disabled";
      else if (rec.paused && rec.pauseReason === "unavailable") advisorState = "unavailable";
      else if (rec.paused) advisorState = "paused";
      else if (reviews.has(spec.name)) advisorState = "busy";
      return {
        name: spec.name,
        state: advisorState,
        enabled: spec.enabled !== false,
        available: spec.enabled !== false && !rec.paused,
        provider: spec.provider,
        model: spec.model,
        kind: provider?.kind ?? rec.kind,
        reasoningEffort: spec.reasoningEffort ?? rec.reasoningEffort ?? "default",
        reviews: rec.reviews ?? 0,
        usage: rec.usage ?? null,
        lastError: rec.lastError ?? null
      };
    });
    return {
      ok: true,
      enabled: Boolean(state.enabled),
      paused: Boolean(state.paused),
      reason: state.pauseReason,
      generation: state.generation,
      settingsRevision: Number(state.settingsRevision) || 0,
      projectRoot: state.projectRoot,
      advisors,
      inbox: state.inbox.map((item) => ({
        id: item.id,
        advisor: item.advisor,
        severity: item.severity,
        status: item.status,
        note: item.note,
        sourcePromptId: item.sourcePromptId,
        generation: item.generation
      })),
      emission: "best-effort"
    };
  };
  const handleSettings = async (req) => {
    if (req?.protocolVersion !== PROTOCOL_VERSION) return settingsFail(SETTINGS_ERRORS.PROTOCOL);
    if (shuttingDown || closed || state.ended) return settingsFail(SETTINGS_ERRORS.STALE);
    return settingsSnapshot();
  };
  const handleApply = async (req) => {
    if (req?.protocolVersion !== PROTOCOL_VERSION) return settingsFail(SETTINGS_ERRORS.PROTOCOL);
    if (shuttingDown || closed || state.ended) return settingsFail(SETTINGS_ERRORS.STALE);
    if (req.workerGeneration == null || req.settingsRevision == null || req.configRevision == null || req.configRevision === "") {
      return settingsFail(SETTINGS_ERRORS.CONFIG);
    }
    if (Number(req.workerGeneration) !== Number(state.workerGeneration)) {
      return settingsFail(SETTINGS_ERRORS.STALE);
    }
    if (Number(req.settingsRevision) !== Number(state.settingsRevision || 0)) {
      return settingsFail(SETTINGS_ERRORS.STALE);
    }
    const first = await readConfigExact();
    if (!first?.config || first.configError || first.revision == null) {
      return settingsFail(SETTINGS_ERRORS.CONFIG);
    }
    if (first.revision !== req.configRevision) return settingsFail(SETTINGS_ERRORS.CONFIG);
    const second = await readConfigExact();
    if (!second || second.revision !== first.revision) return settingsFail(SETTINGS_ERRORS.CONFIG);
    if (shuttingDown || closed || state.ended) return settingsFail(SETTINGS_ERRORS.STALE);
    for (const advisor of first.config.advisors ?? []) {
      if (advisor.enabled === false) continue;
      const provider = first.config.providers?.[advisor.provider];
      if (apiKeyMissing(provider, env)) return settingsFail(SETTINGS_ERRORS.UNAVAILABLE);
    }
    const prepared = await prepareActivationRoot();
    if (!prepared.ok) {
      return settingsFail(
        prepared.reason === "runtime" ? SETTINGS_ERRORS.UNAVAILABLE : SETTINGS_ERRORS.ROOT
      );
    }
    if (shuttingDown || closed || state.ended) return settingsFail(SETTINGS_ERRORS.STALE);
    const wantEnabled = req.enable === true ? true : Boolean(state.enabled);
    const result = await activateFromConfig({
      config: first.config,
      revision: first.revision,
      wantEnabled,
      mode: "apply",
      frozenRoot: prepared.frozenRoot,
      rootIdent: prepared.rootIdent
    });
    if (result?.ok === false) return result;
    return settingsSnapshot();
  };
  const handleDoctor = async () => {
    const runtime = deps.runtimeErrors({ env }) ?? [];
    let configOk = true;
    let configError;
    let loadedConfig = null;
    try {
      loadedConfig = await deps.loadConfig({ env, projectRoot });
    } catch (error) {
      configOk = false;
      configError = sanitizeText(error.message, secrets());
    }
    let rootOk = true;
    let rootError;
    try {
      await deps.validateRoot(projectRoot);
    } catch (error) {
      rootOk = false;
      rootError = sanitizeText(error.message, secrets());
    }
    const keys = [];
    const snapshot = state.activation;
    const keySource = snapshot ?? loadedConfig;
    for (const name of secretNamesFromSnapshot(keySource)) {
      keys.push({ name, present: Boolean(env[name]) });
    }
    const providerDiagnostics = [];
    const providers = snapshot?.providers ?? loadedConfig?.providers ?? {};
    const advisorList = snapshot?.advisors ?? loadedConfig?.advisors ?? [];
    const maxOutputTokens = outputTokenLimit(snapshot?.limits ?? loadedConfig?.limits);
    for (const [slot, provider] of Object.entries(providers)) {
      const advisor = advisorList.find((item) => item.provider === slot) ?? { name: slot, provider: slot };
      const diagnostic = unsupportedProviderDiagnostic(provider) ?? await deps.validateApi({ provider, advisor, env, maxOutputTokens });
      const errorText = diagnostic?.available ? void 0 : sanitizeText(diagnosticErrorText(diagnostic), secrets());
      providerDiagnostics.push({
        slot,
        provider: typeof provider?.provider === "string" ? provider.provider : "",
        kind: typeof provider?.kind === "string" ? provider.kind : "",
        available: Boolean(diagnostic?.available),
        error: errorText
      });
    }
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT || pluginRootFromHere();
    const bundle = bundleStatus(pluginRoot);
    return {
      ok: runtime.length === 0 && configOk && rootOk && bundle.ok,
      runtime: {
        node: { ok: !runtime.some((item) => /node/i.test(item)), version: process.versions.node },
        os: { ok: !runtime.some((item) => /os|platform|darwin|linux/i.test(item)), platform: process.platform },
        errors: runtime
      },
      config: { ok: configOk, error: configError },
      root: { ok: rootOk, error: rootError },
      keys,
      providers: providerDiagnostics,
      bundle,
      ipc: { ok: Boolean(server?.listening), socketPath: socket.socketPath }
    };
  };
  const handleHook = async (payload, client) => {
    const issuer = normalizeClient(client);
    hookClient = issuer;
    try {
      if (!payload || typeof payload !== "object") return { stdout: "" };
      if (payload.agent_id) return { stdout: "" };
      if (payload.cwd && state.projectRoot && !cwdInsideRoot(payload.cwd, state.projectRoot, state.rootIdent)) {
        if (payload.hook_event_name !== "SessionStart") {
          state.cwdOutsideRoot = true;
          state.paused = true;
          state.pauseReason = "cwd-outside-root";
          cancelAll("cwd");
        }
      }
      try {
        if (payload.transcript_path) await ingestTranscript(payload.transcript_path);
      } catch (error) {
        await errors.record(error);
      }
      const event = payload.hook_event_name;
      switch (event) {
        case "SessionStart":
          return await handleSessionStart(payload);
        case "UserPromptSubmit":
          return await handlePrompt(payload);
        case "UserPromptExpansion":
          return await handleExpansion(payload);
        case "PreToolUse":
          return await handleTool(payload, "intent");
        case "PostToolUse":
          return await handleTool(payload, "outcome");
        case "PostToolUseFailure":
          return await handleTool(payload, "failure");
        case "Stop":
          return await handleStop(payload);
        case "StopFailure":
          return await handleStopFailure(payload);
        case "PreCompact":
          return await handlePreCompact(payload);
        case "PostCompact":
          return await handlePostCompact(payload);
        case "SessionEnd":
          return await handleSessionEnd(payload);
        default:
          return { stdout: "" };
      }
    } finally {
      if (hookClient === issuer) hookClient = null;
    }
  };
  let serial = Promise.resolve();
  const runSerial = (fn) => {
    const next = serial.then(fn, fn);
    serial = next.catch(() => {
    });
    return next;
  };
  const dispatch = async (req) => {
    bumpIdle();
    const cap = req?.capability;
    if (cap !== controlCapability) throw new Error("unauthorized");
    switch (req.op) {
      case "on":
        return handleOn();
      case "off":
        return handleOff();
      case "status":
        return handleStatus();
      case "doctor":
        return handleDoctor();
      case "hook":
        return handleHook(req.payload ?? req.hook ?? {}, req.client);
      case "ack": {
        const client = normalizeClient(req.client);
        const rec = (state.issuance ?? []).find((item) => item?.claimId === req.claimId);
        if (rec && !clientsMatch(rec.client, client)) {
          return { ok: false, error: SETTINGS_ERRORS.PROTOCOL, emission: "best-effort", client };
        }
        acknowledgeClaim(state.inbox, req.claimId, now());
        clearIssuance(state.issuance, req.claimId);
        await persist();
        return { ok: true, emission: "best-effort", client };
      }
      case "ping":
        return {
          protocolVersion: PROTOCOL_VERSION,
          sessionId,
          projectRoot: state.projectRoot ?? null,
          configPath: configPathOf(),
          workerGeneration: state.workerGeneration,
          settingsRevision: Number(state.settingsRevision) || 0,
          pid: process.pid
        };
      case "settings":
        return handleSettings(req);
      case "apply":
        return handleApply(req);
      default:
        throw new Error("unknown op");
    }
  };
  async function stop({ reason } = {}) {
    if (!stopPromise) {
      stopPromise = (async () => {
        shuttingDown = true;
        cancelPendingSchedule();
        clearTimeout(idleTimer);
        idleTimer = null;
        cancelAll(reason ?? "stop");
        while (pendingWork.size > 0) {
          await Promise.allSettled([...pendingWork]);
        }
        await persist();
        await persistChain;
        closed = true;
        errors.close();
        if (server) {
          await new Promise((resolve) => server.close(() => resolve()));
          server = null;
        }
        await fs.rm(socket.dir, { recursive: true, force: true }).catch(() => {
        });
        await fs.rm(lockDir(dir), { recursive: true, force: true }).catch(() => {
        });
        await fs.rm(locatorPath(dir), { force: true }).catch(() => {
        });
        if (reason === "idle" && options.exitOnIdle !== false) {
          process.exit(0);
        }
      })();
    }
    return stopPromise;
  }
  ;
  await pruneSessions(pluginData, now(), sessionId);
  await persist();
  if (state.transcriptPath) {
    try {
      await ingestTranscript(state.transcriptPath);
    } catch (error) {
      await errors.record(error);
    }
  }
  if (!state.latestTask && !state.compactSummary) {
    state.contextUnavailable = true;
  }
  try {
    if (options.listen !== false) {
      server = await listenIpc(
        socket.socketPath,
        (req, respond) => runSerial(async () => {
          try {
            const result = await dispatch(req);
            const envelope = { ok: true, result };
            if (req?.id != null) envelope.id = req.id;
            respond(envelope);
          } catch (error) {
            await errors.record(error);
            const envelope = {
              ok: false,
              error: sanitizeText(error instanceof Error ? error.message : "error", secrets())
            };
            if (req?.id != null) envelope.id = req.id;
            respond(envelope);
          } finally {
            await persist();
          }
        })
      );
    }
    await atomicWriteJson(locatorPath(dir), locator);
  } catch (error) {
    await fs.rm(socket.dir, { recursive: true, force: true }).catch(() => {
    });
    await fs.rm(lockDir(dir), { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
  bumpIdle();
  return {
    socketPath: socket.socketPath,
    controlCapability,
    sessionDir: dir,
    workerGeneration: state.workerGeneration,
    stop,
    _state: () => state
  };
}
function parseWorkerArgs(argv) {
  const out = { sessionId: null, projectRoot: null, pluginData: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--session") out.sessionId = argv[++i];
    else if (arg === "--root") out.projectRoot = argv[++i];
    else if (arg === "--data") out.pluginData = argv[++i];
  }
  return out;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseWorkerArgs(argv);
  const sessionId = args.sessionId || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  const projectRoot = args.projectRoot || env.CLAUDE_PROJECT_DIR;
  const pluginData = args.pluginData || env.CLAUDE_PLUGIN_DATA;
  await startWorker({
    sessionId,
    projectRoot,
    pluginData,
    env,
    exitOnIdle: true
  });
}
var realPath = (value) => {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
export {
  cwdInsideRoot,
  main,
  startWorker
};
