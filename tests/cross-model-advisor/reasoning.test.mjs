/**
 * Offline reasoning choices and semantic validation. Imports the bundled
 * module. No credentials or network.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reasoningModule = path.join(
  repoRoot,
  "plugins",
  "cross-model-advisor",
  "dist",
  "modules",
  "reasoning.mjs"
);

const { getReasoningChoices, validateReasoning } = await import(reasoningModule);

function valuesOf(result) {
  return result.choices.map((choice) => choice.value);
}

function choice(result, value) {
  return result.choices.find((entry) => entry.value === value);
}

function fullMap(overrides = {}) {
  return {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
    ...overrides
  };
}

function compatibleSlot(extra = {}, modelExtra = {}) {
  return {
    kind: "api",
    provider: "openai-compatible",
    apiKeyEnv: "CMA_TEST_KEY",
    baseUrl: "http://127.0.0.1:9/v1",
    models: {
      "local-model": {
        contextWindow: 8192,
        maxTokens: 2048,
        reasoning: false,
        input: ["text"],
        ...modelExtra
      }
    },
    ...extra
  };
}

const openai = { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" };
const codex = { kind: "oauth", provider: "openai-codex" };
const anthropic = { kind: "api", provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
const google = { kind: "api", provider: "google", apiKeyEnv: "GEMINI_API_KEY" };
const openrouter = { kind: "api", provider: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" };
const xai = { kind: "api", provider: "xai", apiKeyEnv: "XAI_API_KEY" };
const kimiCoding = { kind: "api", provider: "kimi-coding", apiKeyEnv: "KIMI_API_KEY" };
const zai = { kind: "api", provider: "zai", apiKeyEnv: "ZAI_API_KEY" };
const moonshot = { kind: "api", provider: "moonshotai", apiKeyEnv: "MOONSHOT_API_KEY" };
const copilot = { kind: "oauth", provider: "github-copilot" };

test("non-reasoning models offer only Default", async () => {
  const result = await getReasoningChoices(openai, "gpt-4.1");
  assert.equal(result.configurable, false);
  assert.deepEqual(valuesOf(result), ["default"]);
  assert.equal((await validateReasoning(openai, { model: "gpt-4.1" }, 1500)).ok, true);
  assert.equal(
    (await validateReasoning(openai, { model: "gpt-4.1", reasoningEffort: "off" }, 1500)).ok,
    false
  );
});

test("OpenAI luna exposes Off and aliases are omitted when native names match", async () => {
  const result = await getReasoningChoices(openai, "gpt-5.6-luna");
  assert.equal(result.configurable, true);
  assert.deepEqual(valuesOf(result), ["default", "off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(choice(result, "minimal"), undefined);
  assert.equal(choice(result, "off")?.effective, "none");
  assert.equal((await validateReasoning(openai, { model: "gpt-5.6-luna", reasoningEffort: "minimal" }, 1500)).ok, false);
  assert.equal((await validateReasoning(openai, { model: "gpt-5.6-luna", reasoningEffort: "high" }, 1500)).ok, true);
  assert.equal((await validateReasoning(openai, { model: "gpt-5.6-luna" }, 1500)).ok, true);
});

test("Codex luna maps Minimal to native Low and can disable", async () => {
  const result = await getReasoningChoices(codex, "gpt-5.6-luna");
  assert.deepEqual(valuesOf(result), ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(choice(result, "minimal")?.effective, "low");
  assert.equal(choice(result, "off")?.effective, "none");
  assert.equal((await validateReasoning(codex, { model: "gpt-5.6-luna", reasoningEffort: "off" }, 1500)).ok, true);
});

test("kimi-coding k3 rejects Off because thinking is mandatory", async () => {
  const result = await getReasoningChoices(kimiCoding, "k3");
  assert.deepEqual(valuesOf(result), ["default", "low", "high", "max"]);
  assert.equal((await validateReasoning(kimiCoding, { model: "k3", reasoningEffort: "off" }, 1500)).ok, false);
  assert.equal((await validateReasoning(kimiCoding, { model: "k3", reasoningEffort: "medium" }, 1500)).ok, false);
  assert.equal((await validateReasoning(kimiCoding, { model: "k3", reasoningEffort: "high" }, 1500)).ok, true);
});

test("xai grok-4.3 Off is sent as none", async () => {
  const result = await getReasoningChoices(xai, "grok-4.3");
  assert.deepEqual(valuesOf(result), ["default", "off", "low", "medium", "high"]);
  assert.equal(choice(result, "off")?.effective, "none");
});

test("OpenRouter gpt-5 cannot disable thinking", async () => {
  const result = await getReasoningChoices(openrouter, "openai/gpt-5");
  assert.equal(choice(result, "off"), undefined);
  assert.equal(
    (await validateReasoning(openrouter, { model: "openai/gpt-5", reasoningEffort: "off" }, 1500)).ok,
    false
  );
  assert.equal(
    (await validateReasoning(openrouter, { model: "openai/gpt-5", reasoningEffort: "medium" }, 1500)).ok,
    true
  );
});

test("Gemini 3 Flash does not offer Off", async () => {
  const result = await getReasoningChoices(google, "gemini-3-flash-preview");
  assert.equal(choice(result, "off"), undefined);
  assert.equal(
    (await validateReasoning(google, { model: "gemini-3-flash-preview", reasoningEffort: "off" }, 1500)).ok,
    false
  );
});

test("Anthropic adaptive Off is disableable without a token budget", async () => {
  const result = await getReasoningChoices(anthropic, "claude-sonnet-4-6");
  assert.equal(choice(result, "off")?.effective, "disabled");
  assert.equal(choice(result, "minimal")?.effective, "low");
  assert.equal(
    (await validateReasoning(anthropic, { model: "claude-sonnet-4-6", reasoningEffort: "off" }, 1500)).ok,
    true
  );
  assert.equal(
    (await validateReasoning(anthropic, { model: "claude-sonnet-4-6", reasoningEffort: "minimal" }, 1500)).ok,
    true
  );
  assert.equal(
    (await validateReasoning(anthropic, { model: "claude-sonnet-4-6", reasoningEffort: "high" }, 1500)).ok,
    true
  );
});

test("Anthropic budget models reject efforts that would expand the output ceiling", async () => {
  const advisor = { model: "claude-haiku-4-5", reasoningEffort: "medium" };
  const blocked = await validateReasoning(anthropic, advisor, 1500);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "reasoning budget exceeds the configured output limit");
  assert.equal((await validateReasoning(anthropic, { model: "claude-haiku-4-5", reasoningEffort: "off" }, 1500)).ok, true);
  assert.equal(
    (await validateReasoning(anthropic, { model: "claude-haiku-4-5", reasoningEffort: "high" }, 20_000)).ok,
    true
  );
});

test("Google 2.5 Flash budget levels that cannot leave answer room are rejected", async () => {
  assert.equal(
    (await validateReasoning(google, { model: "gemini-2.5-flash", reasoningEffort: "minimal" }, 1500)).ok,
    true
  );
  const blocked = await validateReasoning(google, { model: "gemini-2.5-flash", reasoningEffort: "low" }, 1500);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "reasoning budget exceeds the configured output limit");
});

test("compatible models stay Default-only until paired thinking metadata exists", async () => {
  const slot = compatibleSlot({}, { reasoning: true });
  const result = await getReasoningChoices(slot, "local-model");
  assert.equal(result.configurable, false);
  assert.deepEqual(valuesOf(result), ["default"]);
  assert.equal((await validateReasoning(slot, { model: "local-model" }, 1500)).ok, true);
  assert.equal(
    (await validateReasoning(slot, { model: "local-model", reasoningEffort: "high" }, 1500)).ok,
    false
  );
});

test("compatible paired openai map exposes exact verified levels and aliases", async () => {
  const slot = compatibleSlot(
    {},
    {
      reasoning: true,
      thinkingFormat: "openai",
      thinkingLevelMap: fullMap({ off: "none", minimal: "low" })
    }
  );
  const result = await getReasoningChoices(slot, "local-model");
  assert.equal(result.configurable, true);
  assert.deepEqual(valuesOf(result), ["default", "off", "minimal", "low", "medium", "high"]);
  assert.equal(choice(result, "minimal")?.effective, "low");
  assert.equal(choice(result, "off")?.effective, "none");
  assert.equal((await validateReasoning(slot, { model: "local-model", reasoningEffort: "xhigh" }, 1500)).ok, false);
  assert.equal((await validateReasoning(slot, { model: "local-model", reasoningEffort: "medium" }, 1500)).ok, true);
});

test("malformed compatible thinking pair fails validation even for Default", async () => {
  const unpaired = compatibleSlot({}, { reasoning: true, thinkingFormat: "openai" });
  const incomplete = compatibleSlot(
    {},
    { reasoning: true, thinkingFormat: "openai", thinkingLevelMap: { low: "low" } }
  );
  const unknownFormat = compatibleSlot(
    {},
    { reasoning: true, thinkingFormat: "deepseek", thinkingLevelMap: fullMap() }
  );
  for (const slot of [unpaired, incomplete, unknownFormat]) {
    const result = await validateReasoning(slot, { model: "local-model" }, 1500);
    assert.equal(result.ok, false);
    assert.equal(result.error, "compatible model thinking metadata is invalid");
  }
});

test("unknown effort strings are invalid", async () => {
  const result = await validateReasoning(openai, { model: "gpt-4.1", reasoningEffort: "turbo" }, 1500);
  assert.equal(result.ok, false);
  assert.equal(result.error, "reasoning effort is invalid");
});

test("Copilot Chat Completions gemini-3.5-flash cannot transmit effort", async () => {
  const result = await getReasoningChoices(copilot, "gemini-3.5-flash");
  assert.equal(result.configurable, false);
  assert.deepEqual(valuesOf(result), ["default"]);
  assert.equal(
    (await validateReasoning(copilot, { model: "gemini-3.5-flash", reasoningEffort: "high" }, 1500)).ok,
    false
  );
  assert.equal(
    (await validateReasoning(copilot, { model: "gemini-3.5-flash", reasoningEffort: "off" }, 1500)).ok,
    false
  );
  assert.equal((await validateReasoning(copilot, { model: "gemini-3.5-flash" }, 1500)).ok, true);
});

test("Google 2.5 Pro cannot disable thinking", async () => {
  const result = await getReasoningChoices(google, "gemini-2.5-pro");
  assert.equal(choice(result, "off"), undefined);
  assert.equal(
    (await validateReasoning(google, { model: "gemini-2.5-pro", reasoningEffort: "off" }, 1500)).ok,
    false
  );
  assert.equal((await validateReasoning(google, { model: "gemini-2.5-pro" }, 1500)).ok, true);
});

test("enable-only ZAI and Moonshot collapse discrete efforts to enabled", async () => {
  const glm = await getReasoningChoices(zai, "glm-4.7");
  assert.equal(glm.configurable, true);
  assert.equal(choice(glm, "off")?.effective, "disabled");
  for (const level of ["minimal", "low", "medium", "high"]) {
    assert.equal(choice(glm, level)?.effective, "enabled", level);
  }
  assert.equal((await validateReasoning(zai, { model: "glm-4.7", reasoningEffort: "low" }, 1500)).ok, true);

  const kimi = await getReasoningChoices(moonshot, "kimi-k2.5");
  assert.equal(kimi.configurable, true);
  assert.equal(choice(kimi, "off")?.effective, "disabled");
  for (const level of ["minimal", "low", "medium", "high"]) {
    assert.equal(choice(kimi, level)?.effective, "enabled", level);
  }
  assert.equal((await validateReasoning(moonshot, { model: "kimi-k2.5", reasoningEffort: "high" }, 1500)).ok, true);
});

test("compatible enable-only zai map does not invent discrete native efforts", async () => {
  const slot = compatibleSlot(
    {},
    {
      reasoning: true,
      thinkingFormat: "zai",
      thinkingLevelMap: fullMap({
        off: "disabled",
        minimal: "enabled",
        low: "enabled",
        medium: "enabled",
        high: "enabled"
      })
    }
  );
  const result = await getReasoningChoices(slot, "local-model");
  assert.equal(choice(result, "off")?.effective, "disabled");
  assert.equal(choice(result, "low")?.effective, "enabled");
  assert.equal(choice(result, "high")?.effective, "enabled");
  assert.equal((await validateReasoning(slot, { model: "local-model", reasoningEffort: "high" }, 1500)).ok, true);
});
