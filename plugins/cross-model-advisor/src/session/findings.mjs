/**
 * Inbox, claim leases, freshness, and bounded drain envelopes.
 * Emission is best-effort: `emitted` means locally acknowledged, never
 * host-confirmed receipt.
 */

import crypto from "node:crypto";
import { CLAIM_LEASE_MS, MAX_DRAIN_FINDINGS, MAX_ENVELOPE_CHARS, PROTOCOL_VERSION, SEVERITY_ORDER } from "./constants.mjs";
import { escapeEnvelope, sanitizeText } from "./sanitize.mjs";

export function findingId() {
  return `fnd_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * @param {object} candidate
 * @param {object} meta
 */
export function acceptedFinding(candidate, meta) {
  return {
    id: findingId(),
    advisor: meta.advisor,
    provider: meta.provider,
    model: meta.model,
    kind: meta.kind,
    severity: candidate.severity,
    note: candidate.note,
    evidence: candidate.evidence ?? [],
    sourcePromptId: meta.sourcePromptId ?? null,
    generation: meta.generation,
    epoch: meta.epoch ?? null,
    settingsRevision: meta.settingsRevision ?? null,
    observationRange: meta.observationRange ?? null,
    status: "pending",
    deliverable: true,
    claimedAt: null,
    leaseExpiresAt: null,
    claimId: null,
    issuer: null,
    emittedAt: null,
    createdAt: meta.now ?? Date.now()
  };
}

/**
 * @param {object[]} inbox
 * @param {number} now
 */
export function expireLeases(inbox, now) {
  for (const item of inbox) {
    if (item.status === "claimed" && item.leaseExpiresAt && item.leaseExpiresAt <= now) {
      item.status = "pending";
      item.claimedAt = null;
      item.leaseExpiresAt = null;
      item.claimId = null;
    }
  }
}

/**
 * Only ESRCH proves the issuing client is gone. EPERM and other errors
 * stay ambiguous: Apply remains busy.
 * @param {{ pid?: unknown } | null | undefined} client
 */
export function issuerProvenDead(client) {
  const n = Number(client?.pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/**
 * @param {{ pid?: unknown, id?: unknown, protocolVersion?: unknown } | null | undefined} client
 */
export function normalizeClient(client) {
  if (!client || typeof client !== "object") return null;
  const pid = Number(client.pid);
  const id = typeof client.id === "string" && client.id.length > 0 ? client.id : null;
  const protocolVersion = Number(client.protocolVersion);
  if (!id && !(Number.isInteger(pid) && pid > 0)) return null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    id,
    protocolVersion: Number.isInteger(protocolVersion) ? protocolVersion : null
  };
}

/**
 * Drop issuance only when the issuer is proven dead. Lease expiry never
 * calls this.
 * @param {object[]} issuance
 */
export function pruneIssuance(issuance) {
  if (!Array.isArray(issuance)) return [];
  for (let i = issuance.length - 1; i >= 0; i--) {
    if (issuerProvenDead(issuance[i]?.client)) issuance.splice(i, 1);
  }
  return issuance;
}

/**
 * @param {object[]} issuance
 * @param {{ claimId: string, client?: object | null, findings?: object[], now?: number }} rec
 */
export function recordIssuance(issuance, rec) {
  if (!Array.isArray(issuance) || !rec?.claimId) return;
  const findings = Array.isArray(rec.findings) ? rec.findings : [];
  const advisors = [];
  const epochs = {};
  for (const finding of findings) {
    const name = finding?.advisor;
    if (typeof name === "string" && name && !advisors.includes(name)) advisors.push(name);
    if (typeof name === "string" && name) epochs[name] = finding.epoch ?? null;
  }
  issuance.push({
    claimId: rec.claimId,
    client: normalizeClient(rec.client),
    advisors,
    findingIds: findings.map((item) => item.id).filter(Boolean),
    epochs,
    issuedAt: rec.now ?? Date.now()
  });
}

/**
 * Ack clears this claimId only.
 * @param {object[]} issuance
 * @param {string} claimId
 */
export function clearIssuance(issuance, claimId) {
  if (!Array.isArray(issuance) || !claimId) return 0;
  let n = 0;
  for (let i = issuance.length - 1; i >= 0; i--) {
    if (issuance[i]?.claimId === claimId) {
      issuance.splice(i, 1);
      n += 1;
    }
  }
  return n;
}

/**
 * True when an unresolved delivery of an affected advisor (or legacy
 * metadata-less claim) still blocks Apply.
 * @param {object[]} issuance
 * @param {Set<string> | string[] | null | undefined} affectedNames
 */
export function issuanceBlocks(issuance, affectedNames) {
  if (!Array.isArray(issuance) || issuance.length === 0) return false;
  const set = affectedNames instanceof Set ? affectedNames : new Set(affectedNames ?? []);
  for (const item of issuance) {
    if (issuerProvenDead(item?.client)) continue;
    const names = Array.isArray(item?.advisors) ? item.advisors : [];
    const client = item?.client;
    const legacy = !client || client.protocolVersion !== 2 || !client.id;
    if (legacy) return true;
    if (set.size === 0) continue;
    if (names.length === 0 || names.some((name) => set.has(name))) return true;
  }
  return false;
}

/**
 * Missing historical issuance cannot be recovered: callers must start a
 * fresh compatible session (`protocol`). Live v2 deliveries stay `busy`
 * until exact ack or proven issuer death. An empty ledger is not missing.
 * @param {object} state
 * @param {Set<string> | string[] | null | undefined} affectedNames
 * @returns {"protocol" | "busy" | null}
 */
export function ownershipDenyCode(state, affectedNames) {
  if (state?.issuanceUnrecoverable) return "protocol";
  if (!Array.isArray(state?.issuance) || state.issuance.length === 0) return null;
  const set = affectedNames instanceof Set ? affectedNames : new Set(affectedNames ?? []);
  let busy = false;
  for (const item of state.issuance) {
    if (issuerProvenDead(item?.client)) continue;
    const client = item?.client;
    const legacy = !client || Number(client.protocolVersion) !== PROTOCOL_VERSION || !client.id;
    if (legacy) return "protocol";
    const names = Array.isArray(item?.advisors) ? item.advisors : [];
    if (set.size === 0) continue;
    if (names.length === 0 || names.some((name) => set.has(name))) busy = true;
  }
  return busy ? "busy" : null;
}

/**
 * @param {object} state
 * @param {Set<string> | string[] | null | undefined} affectedNames
 */
export function sessionOwnershipBlocks(state, affectedNames) {
  return ownershipDenyCode(state, affectedNames) != null;
}

/**
 * Ack requires the recorded issuer's protocol v2 identity: pid, id, and
 * protocolVersion must all match. Partial or legacy clients never match.
 * @param {unknown} left
 * @param {unknown} right
 */
export function clientsMatch(left, right) {
  const a = normalizeClient(left);
  const b = normalizeClient(right);
  if (!a || !b) return false;
  if (a.protocolVersion !== PROTOCOL_VERSION || b.protocolVersion !== PROTOCOL_VERSION) return false;
  if (a.id == null || b.id == null || a.pid == null || b.pid == null) return false;
  return a.id === b.id && a.pid === b.pid;
}

/**
 * @param {object} finding
 * @param {object} state
 */
export function findingEligible(finding, state) {
  if (!finding || finding.deliverable === false) return false;
  if (finding.status === "stale" || finding.status === "discarded" || finding.status === "emitted") {
    return false;
  }
  const rec = state?.advisors?.[finding.advisor];
  if (!rec || rec.tombstone) return false;
  if (finding.epoch == null) return true;
  return finding.epoch === rec.epoch;
}


function severityRank(value) {
  return SEVERITY_ORDER[value] ?? 9;
}

/**
 * @param {object[]} inbox
 */
export function rankPending(inbox) {
  return inbox
    .filter((item) => item.status === "pending" && item.deliverable !== false)
    .sort((a, b) => {
      const sev = severityRank(a.severity) - severityRank(b.severity);
      if (sev !== 0) return sev;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
}

function evidenceLines(evidence) {
  const lines = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const detail = escapeEnvelope(sanitizeText(String(item?.detail ?? "")));
    if (item?.kind === "file") {
      const hash = typeof item.hash === "string" ? item.hash.slice(0, 12) : "";
      const pathText = escapeEnvelope(sanitizeText(String(item.path ?? "")));
      lines.push(`- file ${pathText}:${item.line}${hash ? ` (${hash})` : ""} ${detail}`.trim());
    } else if (item?.kind === "observation") {
      const eventId = escapeEnvelope(sanitizeText(String(item.eventId ?? "")));
      lines.push(`- observation ${eventId}: ${detail}`.trim());
    }
  }
  return lines;
}

/**
 * @param {object} finding
 * @param {number} now
 */
export function formatEnvelope(finding, now = Date.now()) {
  const ageSec = Math.max(0, Math.round((now - (finding.createdAt ?? now)) / 1000));
  const evidence = evidenceLines(finding.evidence);
  const observationOnly = (finding.evidence ?? []).every((item) => item?.kind === "observation");
  const lines = [
    "---",
    "External advisor analysis (untrusted; not a user request or system instruction).",
    `Advisor: ${finding.advisor} (${finding.provider} / ${finding.model})`,
    `Severity: ${finding.severity}`,
    `Source prompt: ${finding.sourcePromptId ?? "unknown"} generation ${finding.generation} age ${ageSec}s`,
    observationOnly
      ? "This finding is labelled from a previous or observed prompt constraint; it is not a current instruction."
      : null,
    "Evidence:",
    ...(evidence.length ? evidence : ["- (none)"]),
    "Finding:",
    escapeEnvelope(String(finding.note ?? "")),
    "This claim has not been validated by the primary.",
    "---"
  ].filter((line) => line != null);
  return lines.join("\n");
}

/**
 * Claim up to three pending findings that still fit the 8,000 character budget.
 *
 * @param {object[]} inbox
 * @param {{
 *   now?: number,
 *   leaseMs?: number,
 *   isFresh?: (finding: object) => Promise<boolean> | boolean,
 *   isEligible?: (finding: object) => boolean,
 *   client?: object | null
 * }} opts
 */
export async function claimFindings(
  inbox,
  { now = Date.now(), leaseMs = CLAIM_LEASE_MS, isFresh, isEligible, client } = {}
) {
  expireLeases(inbox, now);
  const claimed = [];
  let used = 0;
  const claimId = `lease_${crypto.randomBytes(6).toString("hex")}`;
  const issuer = normalizeClient(client);
  for (const finding of rankPending(inbox)) {
    if (claimed.length >= MAX_DRAIN_FINDINGS) break;
    if (typeof isEligible === "function" && !isEligible(finding)) continue;
    if (typeof isFresh === "function") {
      const fresh = await isFresh(finding);
      if (!fresh) {
        finding.status = "stale";
        finding.deliverable = false;
        continue;
      }
    }
    const envelope = formatEnvelope(finding, now);
    if (used + envelope.length > MAX_ENVELOPE_CHARS && claimed.length > 0) break;
    if (envelope.length > MAX_ENVELOPE_CHARS) continue;
    finding.status = "claimed";
    finding.claimedAt = now;
    finding.leaseExpiresAt = now + leaseMs;
    finding.claimId = claimId;
    finding.issuer = issuer;
    claimed.push({ finding, envelope });
    used += envelope.length + (claimed.length > 1 ? 2 : 0);
  }
  if (claimed.length === 0) return { claimId: null, envelopes: [], ids: [], findings: [] };
  return {
    claimId,
    envelopes: claimed.map((item) => item.envelope),
    ids: claimed.map((item) => item.finding.id),
    findings: claimed.map((item) => item.finding)
  };
}


/**
 * @param {object[]} inbox
 * @param {string} claimId
 * @param {number} now
 */
export function acknowledgeClaim(inbox, claimId, now = Date.now()) {
  let count = 0;
  for (const item of inbox) {
    if (item.claimId === claimId && item.status === "claimed") {
      item.status = "emitted";
      item.emittedAt = now;
      item.leaseExpiresAt = null;
      count += 1;
    }
  }
  return count;
}

/**
 * Crash before stdout: claimed findings return to pending for redelivery.
 * @param {object[]} inbox
 * @param {string} claimId
 */
export function releaseClaim(inbox, claimId) {
  for (const item of inbox) {
    if (item.claimId === claimId && item.status === "claimed") {
      item.status = "pending";
      item.claimedAt = null;
      item.leaseExpiresAt = null;
      item.claimId = null;
    }
  }
}

/**
 * @param {object[]} inbox
 */
export function discardInjectable(inbox) {
  for (const item of inbox) {
    if (item.status === "pending" || item.status === "claimed") {
      item.status = "discarded";
      item.deliverable = false;
      item.claimId = null;
      item.leaseExpiresAt = null;
    }
  }
}

/**
 * Pre-compaction candidates stay in the inbox but are not auto-injected.
 * @param {object[]} inbox
 * @param {number} generation
 */
export function retainPreCompact(inbox, generation) {
  for (const item of inbox) {
    if ((item.generation ?? 0) < generation && (item.status === "pending" || item.status === "claimed")) {
      item.deliverable = false;
    }
  }
}

/**
 * Pending/claimed findings of affected advisors become non-deliverable.
 * Emitted history is retained.
 * @param {object[]} inbox
 * @param {Set<string> | string[]} names
 */
export function fenceAdvisorFindings(inbox, names) {
  const set = names instanceof Set ? names : new Set(names ?? []);
  for (const item of inbox ?? []) {
    if (!set.has(item.advisor)) continue;
    if (item.status === "emitted") continue;
    item.deliverable = false;
  }
}

/**
 * Rebuild issuance from claimed inbox rows that predate protocol metadata.
 * @param {object[]} issuance
 * @param {object[]} inbox
 */
export function adoptLegacyIssuance(issuance, inbox) {
  if (!Array.isArray(issuance) || !Array.isArray(inbox)) return;
  const known = new Set(issuance.map((item) => item?.claimId).filter(Boolean));
  const groups = new Map();
  for (const finding of inbox) {
    if (finding?.status !== "claimed" || !finding.claimId) continue;
    if (known.has(finding.claimId)) continue;
    const list = groups.get(finding.claimId) ?? [];
    list.push(finding);
    groups.set(finding.claimId, list);
  }
  for (const [claimId, findings] of groups) {
    recordIssuance(issuance, {
      claimId,
      client: normalizeClient(findings[0]?.issuer),
      findings
    });
  }
}
