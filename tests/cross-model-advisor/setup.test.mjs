/**
 * Setup helper: stale/missing revision, private writes, invalid config
 * leaves the file untouched, and offline catalog/models stay bounded.
 * Imports bundled dist modules. No network or credentials.
 */


import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";


const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, "..", "..", "plugins", "cross-model-advisor");
const modules = path.join(pluginRoot, "dist", "modules");

const { SetupError, runSetup, readConfigState, saveConfig } = await import(
  pathToFileURL(path.join(modules, "setup-store.mjs")).href
);



const scratchDirs = [];

async function scratch(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function envFor(dir) {
  return { CLAUDE_CONFIG_DIR: dir };
}

function configPath(dir) {
  return path.join(dir, "cross-model-advisor.json");
}

function stdoutSink() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    text() {
      return text;
    },
    json() {
      return JSON.parse(text);
    }
  };
}

function stdinOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Readable.from([text]);
}

function baseConfig(overrides = {}) {
  return {
    version: 1,
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
    },
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-4.1",
        instructions: "Look for observable correctness failures."
      }
    ],
    exclude: ["tmp/**"],
    limits: {
      maxConcurrentAdvisors: 2,
      reviewTimeoutSeconds: 90,
      maxToolCallsPerReview: 8,
      maxOutputTokens: 1500,
      maxReviewsPerAdvisorPerSession: 40
    },
    ...overrides
  };
}

async function catalog(dir, extras = {}) {
  const stdout = stdoutSink();
  await runSetup({
    argv: ["catalog"],
    env: envFor(dir),
    stdout,
    stderr: stdoutSink(),
    ...extras
  });
  return stdout.json();
}

async function listModels(dir, argv, extras = {}) {
  const stdout = stdoutSink();
  await runSetup({
    argv,
    env: envFor(dir),
    stdout,
    stderr: stdoutSink(),
    ...extras
  });
  return stdout.json();
}

async function save(dir, payload, extras = {}) {
  const stdout = stdoutSink();
  await runSetup({
    argv: ["save"],
    env: envFor(dir),
    stdin: stdinOf(payload),
    stdout,
    stderr: stdoutSink(),
    ...extras
  });
  return stdout.json();
}

function fakeProvider(id, models) {
  return {
    id,
    name: id,
    getModels() {
      return models;
    }
  };
}

function fakeCreate(modelsById) {
  return (id) => {
    if (!modelsById[id]) throw new Error(`unsupported provider ${id}`);
    return fakeProvider(id, modelsById[id]);
  };
}

describe("catalog", () => {
  it("treats a missing file as first-run and returns provider summaries without model arrays", async () => {
    const dir = await scratch("cma-setup-catalog-");
    const result = await catalog(dir);
    assert.equal(result.ok, true);
    assert.equal(result.revision, null);
    assert.equal(result.config, null);
    assert.equal(result.configError, null);
    assert.equal(result.path, configPath(dir));
    const openai = result.providers.find((entry) => entry.id === "openai");
    assert.equal(openai.auth.includes("api"), true);
    assert.equal(Array.isArray(openai.models), false);
    const openrouter = result.providers.find((entry) => entry.id === "openrouter");
    assert.equal(Array.isArray(openrouter?.models), false);
    assert.equal(typeof openrouter?.modelCount, "number");
    const copilot = result.providers.find((entry) => entry.id === "github-copilot");
    assert.deepEqual(copilot.auth, ["oauth"]);
    const anthropic = result.providers.find((entry) => entry.id === "anthropic");
    assert.deepEqual(anthropic.auth, ["api"]);
  });

  it("reports a broken offline catalog instead of silently offering no models", async () => {
    const dir = await scratch("cma-setup-broken-catalog-");
    await assert.rejects(
      () => catalog(dir, {
        createBuiltinProvider: () => { throw new Error("PRIVATE_CATALOG_ERROR"); }
      }),
      (error) => error.code === "catalog" && !error.message.includes("PRIVATE_CATALOG_ERROR")
    );
  });

  it("returns normalized version-2 config for a version-1 file without rewriting it", async () => {
    const dir = await scratch("cma-setup-existing-");
    const body = `${JSON.stringify(baseConfig(), null, 2)}\n`;
    await fs.writeFile(configPath(dir), body);
    const result = await catalog(dir);
    assert.equal(typeof result.revision, "string");
    assert.equal(result.revision.length, 64);
    assert.equal(result.revision, createHash("sha256").update(body).digest("hex"));
    assert.equal(result.config.version, 2);
    assert.equal(result.config.advisors[0].name, "correctness");
    assert.equal(result.config.advisors[0].enabled, true);
    assert.equal(result.config.advisors[0].reasoningEffort, "default");
    assert.deepEqual(result.config.exclude, ["tmp/**"]);
    assert.equal(result.configError, null);
    assert.equal(await fs.readFile(configPath(dir), "utf8"), body);
    const onDisk = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(Object.hasOwn(onDisk.advisors[0], "enabled"), false);
  });

  it("readConfigState normalizes a version-1 file and leaves its bytes unchanged", async () => {
    const dir = await scratch("cma-setup-read-state-");
    const body = `${JSON.stringify(baseConfig(), null, 2)}\n`;
    await fs.writeFile(configPath(dir), body);
    const state = await readConfigState({ env: envFor(dir) });
    assert.equal(state.config.version, 2);
    assert.equal(state.config.advisors[0].enabled, true);
    assert.equal(state.config.advisors[0].reasoningEffort, "default");
    assert.equal(state.revision, createHash("sha256").update(body).digest("hex"));
    assert.equal(state.configError, null);
    assert.equal(await fs.readFile(configPath(dir), "utf8"), body);
  });
});


describe("models", () => {

  it("paginates and searches without network", async () => {
    const dir = await scratch("cma-setup-page-");
    const createBuiltinProvider = fakeCreate({
      openai: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "gamma", name: "Gamma" }
      ]
    });
    const page = await listModels(dir, ["models", "openai", "--offset", "1", "--limit", "1"], {
      createBuiltinProvider
    });
    assert.equal(page.total, 3);
    assert.equal(page.models.length, 1);
    assert.equal(page.models[0].id, "beta");
    const search = await listModels(dir, ["models", "openai", "--q", "amm"], { createBuiltinProvider });
    assert.deepEqual(
      search.models.map((entry) => entry.id),
      ["gamma"]
    );
  });

  it("does not invent compatible models", async () => {
    const dir = await scratch("cma-setup-compat-");
    const result = await listModels(dir, ["models", "openai-compatible"]);
    assert.equal(result.total, 0);
    assert.deepEqual(result.models, []);
    assert.equal(typeof result.hint, "string");
  });

  it("rejects an unknown provider id without writing", async () => {
    const dir = await scratch("cma-setup-unknown-");
    await assert.rejects(
      () => listModels(dir, ["models", "not-a-provider"]),
      (error) => error instanceof SetupError && error.code === "provider"
    );
    await assert.rejects(() => fs.stat(configPath(dir)));
  });
});

describe("save", () => {
  it("writes a private version-2 file on first run and preserves exclude and limits", async () => {
    const dir = path.join(await scratch("cma-setup-save-"), "new-config-directory");
    const config = baseConfig();
    const result = await save(dir, { revision: null, config });
    assert.equal(result.ok, true);
    assert.equal(typeof result.revision, "string");
    const file = configPath(dir);
    const st = await fs.lstat(file);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.mode & 0o777, 0o600);
    const written = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(written.version, 2);
    assert.equal(written.advisors[0].enabled, true);
    assert.equal(written.advisors[0].reasoningEffort, "default");
    assert.deepEqual(written.exclude, ["tmp/**"]);
    assert.equal(written.limits.maxOutputTokens, 1500);
    assert.equal(written.advisors[0].model, "gpt-4.1");
  });


  it("rejects a stale revision and leaves the intervening file intact", async () => {
    const dir = await scratch("cma-setup-stale-");
    const first = await save(dir, { revision: null, config: baseConfig() });
    const changed = baseConfig({
      advisors: [
        {
          name: "architecture",
          provider: "openai-api",
          model: "gpt-4.1",
          instructions: "Look for avoidable complexity."
        }
      ]
    });
    await fs.writeFile(configPath(dir), `${JSON.stringify(changed, null, 2)}\n`);
    await assert.rejects(
      () => save(dir, { revision: first.revision, config: baseConfig() }),
      (error) => error instanceof SetupError && error.code === "revision"
    );
    const onDisk = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(onDisk.advisors[0].name, "architecture");
  });
  it("lets only one concurrent first-time save publish its configuration", async () => {
    const dir = await scratch("cma-setup-concurrent-");
    const configs = [baseConfig(), baseConfig()];
    configs[0].advisors[0].instructions = "Review correctness.";
    configs[1].advisors[0].instructions = "Review maintainability.";
    const results = await Promise.allSettled(configs.map((config) => save(dir, { revision: null, config })));
    const winner = results.findIndex((result) => result.status === "fulfilled");
    assert.notEqual(winner, -1);
    const loser = results[1 - winner];
    assert.equal(loser.status, "rejected");
    assert.ok(["busy", "revision"].includes(loser.reason.code));
    const stored = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(stored.advisors[0].instructions, configs[winner].advisors[0].instructions);
  });


  it("rejects non-null revisions for missing files and null for existing files", async () => {
    const dir = await scratch("cma-setup-rev-");
    await assert.rejects(
      () => save(dir, { revision: "a".repeat(64), config: baseConfig() }),
      (error) => error instanceof SetupError && error.code === "revision"
    );
    await assert.rejects(() => fs.stat(configPath(dir)));
    await save(dir, { revision: null, config: baseConfig() });
    await assert.rejects(
      () => save(dir, { revision: null, config: baseConfig() }),
      (error) => error instanceof SetupError && error.code === "revision"
    );
  });

  it("does not write when a version-1 empty config is invalid", async () => {
    const dir = await scratch("cma-setup-invalid-");
    await assert.rejects(
      () => save(dir, { revision: null, config: { version: 1, providers: {}, advisors: [] } }),
      (error) => error instanceof SetupError && error.code === "config"
    );
    await assert.rejects(() => fs.stat(configPath(dir)));
  });


  it("refuses a symlink config path without replacing it", async () => {
    const dir = await scratch("cma-setup-link-");
    const target = path.join(dir, "elsewhere.json");
    await fs.writeFile(target, `${JSON.stringify(baseConfig(), null, 2)}\n`);
    await fs.symlink(target, configPath(dir));
    await assert.rejects(
      () => save(dir, { revision: null, config: baseConfig() }),
      (error) => error instanceof SetupError && error.code === "symlink"
    );
    const st = await fs.lstat(configPath(dir));
    assert.equal(st.isSymbolicLink(), true);
  });

  it("saves an empty version-2 configuration as a valid disabled setup", async () => {
    const dir = await scratch("cma-setup-empty-v2-");
    const result = await saveConfig(
      { revision: null, config: { version: 2, providers: {}, advisors: [] } },
      { env: envFor(dir) }
    );
    assert.equal(result.ok, true);
    const written = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(written.version, 2);
    assert.deepEqual(written.providers, {});
    assert.deepEqual(written.advisors, []);
  });

  it("preserves explicit enabled and reasoning effort on a version-2 save", async () => {
    const dir = await scratch("cma-setup-effort-");
    const thinkingLevelMap = {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null
    };
    const config = {
      version: 2,
      providers: {
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "SMOKE_KEY",
          baseUrl: "http://127.0.0.1:8765/v1",
          models: {
            "smoke-model": {
              contextWindow: 32000,
              maxTokens: 2048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai",
              thinkingLevelMap
            }
          }
        }
      },
      advisors: [
        {
          name: "smoke",
          provider: "loopback",
          model: "smoke-model",
          instructions: "Inspect the fixture.",
          enabled: false,
          reasoningEffort: "high"
        }
      ],
      exclude: ["tmp/**"],
      limits: {
        maxConcurrentAdvisors: 2,
        reviewTimeoutSeconds: 90,
        maxToolCallsPerReview: 8,
        maxOutputTokens: 1500,
        maxReviewsPerAdvisorPerSession: 40
      }
    };
    const result = await saveConfig({ revision: null, config }, { env: envFor(dir) });
    assert.equal(result.ok, true);
    const written = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(written.version, 2);
    assert.equal(written.advisors[0].enabled, false);
    assert.equal(written.advisors[0].reasoningEffort, "high");
    assert.equal(written.advisors[0].instructions, "Inspect the fixture.");
    assert.deepEqual(written.exclude, ["tmp/**"]);
    assert.equal(written.providers.loopback.models["smoke-model"].thinkingFormat, "openai");
    assert.equal("supportsReasoningEffort" in written.providers.loopback.models["smoke-model"], false);
  });

  it("rejects unsupported reasoning effort before disk mutation", async () => {
    const dir = await scratch("cma-setup-unsupported-effort-");
    const thinkingLevelMap = {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: null,
      max: null
    };
    const advisor = {
      name: "smoke",
      provider: "loopback",
      model: "smoke-model",
      instructions: "Inspect the fixture.",
      enabled: true
    };
    const providers = {
      loopback: {
        kind: "api",
        provider: "openai-compatible",
        apiKeyEnv: "SMOKE_KEY",
        baseUrl: "http://127.0.0.1:8765/v1",
        models: {
          "smoke-model": {
            contextWindow: 32000,
            maxTokens: 2048,
            reasoning: true,
            input: ["text"],
            thinkingFormat: "openai",
            thinkingLevelMap
          }
        }
      }
    };
    const unsupported = {
      version: 2,
      providers,
      advisors: [{ ...advisor, reasoningEffort: "high" }]
    };
    await assert.rejects(
      () => saveConfig({ revision: null, config: unsupported }, { env: envFor(dir) }),
      (error) => error instanceof SetupError && error.code === "config"
    );
    await assert.rejects(() => fs.stat(configPath(dir)));
    const valid = {
      version: 2,
      providers,
      advisors: [{ ...advisor, reasoningEffort: "default" }]
    };
    const saved = await saveConfig({ revision: null, config: valid }, { env: envFor(dir) });
    const before = await fs.readFile(configPath(dir), "utf8");
    await assert.rejects(
      () => saveConfig({ revision: saved.revision, config: unsupported }, { env: envFor(dir) }),
      (error) => error instanceof SetupError && error.code === "config"
    );
    assert.equal(await fs.readFile(configPath(dir), "utf8"), before);
  });


  it("rejects malformed compatible reasoning metadata without writing", async () => {
    const dir = await scratch("cma-setup-malformed-reasoning-");
    const config = {
      version: 2,
      providers: {
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "SMOKE_KEY",
          baseUrl: "http://127.0.0.1:8765/v1",
          models: {
            "smoke-model": {
              contextWindow: 32000,
              maxTokens: 2048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai"
            }
          }
        }
      },
      advisors: [
        {
          name: "smoke",
          provider: "loopback",
          model: "smoke-model",
          instructions: "Inspect the fixture.",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    };
    await assert.rejects(
      () => saveConfig({ revision: null, config }, { env: envFor(dir) }),
      (error) => error instanceof SetupError && error.code === "config"
    );
    await assert.rejects(() => fs.stat(configPath(dir)));
  });

  it("saves explicit supportsReasoningEffort and rejects it without a thinking pair", async () => {
    const dir = await scratch("cma-setup-effort-cap-");
    const thinkingLevelMap = {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null
    };
    const zaiMap = {
      off: "disabled",
      minimal: "enabled",
      low: "enabled",
      medium: "enabled",
      high: "enabled",
      xhigh: null,
      max: null
    };
    const advisor = {
      name: "smoke",
      provider: "loopback",
      model: "smoke-model",
      instructions: "Inspect the fixture.",
      enabled: true,
      reasoningEffort: "default"
    };
    const loopback = (model) => ({
      kind: "api",
      provider: "openai-compatible",
      apiKeyEnv: "SMOKE_KEY",
      baseUrl: "http://127.0.0.1:8765/v1",
      models: { "smoke-model": model }
    });
    const baseMeta = {
      contextWindow: 32000,
      maxTokens: 2048,
      reasoning: true,
      input: ["text"]
    };
    const native = await saveConfig(
      {
        revision: null,
        config: {
          version: 2,
          providers: {
            loopback: loopback({
              ...baseMeta,
              thinkingFormat: "openai",
              thinkingLevelMap,
              supportsReasoningEffort: true
            })
          },
          advisors: [advisor]
        }
      },
      { env: envFor(dir) }
    );
    assert.equal(native.ok, true);
    const writtenNative = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
    assert.equal(writtenNative.providers.loopback.models["smoke-model"].supportsReasoningEffort, true);
    const enableOnlyDir = await scratch("cma-setup-effort-cap-zai-");
    const enableOnly = await saveConfig(
      {
        revision: null,
        config: {
          version: 2,
          providers: {
            loopback: loopback({
              ...baseMeta,
              thinkingFormat: "zai",
              thinkingLevelMap: zaiMap,
              supportsReasoningEffort: false
            })
          },
          advisors: [advisor]
        }
      },
      { env: envFor(enableOnlyDir) }
    );
    assert.equal(enableOnly.ok, true);
    const writtenEnableOnly = JSON.parse(await fs.readFile(configPath(enableOnlyDir), "utf8"));
    assert.equal(writtenEnableOnly.providers.loopback.models["smoke-model"].supportsReasoningEffort, false);
    const unpairedDir = await scratch("cma-setup-effort-cap-unpaired-");
    await assert.rejects(
      () =>
        saveConfig(
          {
            revision: null,
            config: {
              version: 2,
              providers: {
                loopback: loopback({ ...baseMeta, supportsReasoningEffort: true })
              },
              advisors: [advisor]
            }
          },
          { env: envFor(unpairedDir) }
        ),
      (error) => error instanceof SetupError && error.code === "config"
    );
    await assert.rejects(() => fs.stat(configPath(unpairedDir)));
  });


});
