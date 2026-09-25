#!/usr/bin/env node
/**
 * Behavioral boundary tests for config validation and shared review tools.
 * Imports bundled dist modules, not unbundled source.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(here, "..", "..", "plugins", "cross-model-advisor");
const modules = path.join(pluginRoot, "dist", "modules");

const { loadConfig, validateConfig, validateRoot, runtimeErrors, snapshotRoot } = await import(
  pathToFileURL(path.join(modules, "config.mjs")).href
);
const { createReviewTools, normalizeFinding } = await import(
  pathToFileURL(path.join(modules, "tools.mjs")).href
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
    exclude: [],
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

function listingNames(text) {
  return String(text)
    .split("\n")
    .map((line) => line.replace(/\/$/, ""))
    .filter((line) => line && line !== "[truncated]");
}

describe("validateConfig", () => {
  it("normalizes version-1 advisors to enabled default effort and fills omitted limits", () => {
    const { limits, ...rest } = baseConfig();
    const parsed = validateConfig(rest);
    void limits;
    assert.equal(parsed.version, 2);
    assert.equal(parsed.advisors[0].model, "gpt-4.1");
    assert.equal(parsed.advisors[0].enabled, true);
    assert.equal(parsed.advisors[0].reasoningEffort, "default");
    assert.equal(parsed.limits.maxConcurrentAdvisors, 2);
    assert.equal(parsed.limits.reviewTimeoutSeconds, 90);
    assert.deepEqual(parsed.exclude, []);
  });


  it("rejects unknown keys, ambient key values, and default-less malformed entries", () => {
    assert.throws(() => validateConfig({ ...baseConfig(), extra: true }));
    assert.throws(() => validateConfig({ ...baseConfig(), version: 2 }));
    assert.throws(() => validateConfig({ ...baseConfig(), version: 3 }));


    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "openai-api": { kind: "api", provider: "openai", apiKey: "sk-live-not-an-env" } }
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "openai-api": { kind: "api", provider: "openai" } }
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "codex-login": { kind: "cli", cli: "codex" } },
        advisors: [{ name: "x", provider: "codex-login", model: "gpt", instructions: "check" }]
      })
    );
    assert.throws(() => validateConfig({ ...baseConfig(), exclude: ["!secret"] }));
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        advisors: [
          { name: "correctness", provider: "openai-api", model: "a", instructions: "one" },
          { name: "correctness", provider: "openai-api", model: "b", instructions: "two" }
        ]
      })
    );
  });

  it("requires openai-compatible metadata and loopback-only HTTP", () => {
    const compatible = (baseUrl, models) =>
      validateConfig({
        ...baseConfig(),
        providers: {
          loopback: {
            kind: "api",
            provider: "openai-compatible",
            apiKeyEnv: "SMOKE_KEY",
            baseUrl,
            models
          }
        },
        advisors: [
          {
            name: "smoke",
            provider: "loopback",
            model: "smoke-model",
            instructions: "Inspect the fixture."
          }
        ]
      });
    const models = {
      "smoke-model": {
        contextWindow: 32000,
        maxTokens: 2048,
        reasoning: false,
        input: ["text"],
        pricing: { prompt: 0, completion: 0 }
      }
    };
    const ok = compatible("http://127.0.0.1:8765/v1", models);
    assert.equal(ok.providers.loopback.baseUrl.includes("127.0.0.1"), true);
    assert.equal(ok.providers.loopback.models["smoke-model"].reasoning, false);
    assert.throws(() => compatible("http://example.com/v1", models));
    assert.throws(() => compatible("http://127.0.0.1:8765/v1", {}));
    assert.throws(() =>
      compatible("http://127.0.0.1:8765/v1", {
        "smoke-model": { contextWindow: 1, maxTokens: 1, reasoning: "high", input: ["text"] }
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: {
          loopback: {
            kind: "api",
            provider: "openai-compatible",
            apiKeyEnv: "SMOKE_KEY",
            baseUrl: "http://127.0.0.1:9/v1",
            models
          }
        },
        advisors: [
          { name: "smoke", provider: "loopback", model: "other", instructions: "Inspect the fixture." }
        ]
      })
    );
  });

  it("accepts OAuth slots and rejects CLI and unsupported auth combinations", () => {
    const parsed = validateConfig({
      ...baseConfig(),
      providers: {
        "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" },
        "codex-login": { kind: "oauth", provider: "openai-codex" },
        "xai-api": { kind: "api", provider: "xai", apiKeyEnv: "XAI_API_KEY" },
        "xai-login": { kind: "oauth", provider: "xai" }
      },
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-4.1",
          instructions: "Look for observable correctness failures."
        },
        {
          name: "architecture",
          provider: "codex-login",
          model: "gpt-5.4",
          instructions: "Look for avoidable complexity."
        }
      ]
    });
    assert.equal(parsed.providers["codex-login"].kind, "oauth");
    assert.equal(parsed.providers["codex-login"].provider, "openai-codex");
    assert.equal(Object.hasOwn(parsed.providers["codex-login"], "apiKeyEnv"), false);
    assert.equal(parsed.providers["xai-api"].kind, "api");
    assert.equal(parsed.providers["xai-login"].kind, "oauth");

    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "codex-login": { kind: "cli", cli: "codex" } },
        advisors: [{ name: "x", provider: "codex-login", model: "gpt", instructions: "check" }]
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "claude-login": { kind: "oauth", provider: "anthropic" } },
        advisors: [{ name: "x", provider: "claude-login", model: "claude-sonnet-4-5", instructions: "check" }]
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: {
          "codex-login": { kind: "oauth", provider: "openai-codex", apiKeyEnv: "OPENAI_API_KEY" }
        },
        advisors: [{ name: "x", provider: "codex-login", model: "gpt", instructions: "check" }]
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: { "codex-api": { kind: "api", provider: "openai-codex", apiKeyEnv: "OPENAI_API_KEY" } },
        advisors: [{ name: "x", provider: "codex-api", model: "gpt", instructions: "check" }]
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: {
          "copilot-api": { kind: "api", provider: "github-copilot", apiKeyEnv: "COPILOT_GITHUB_TOKEN" }
        },
        advisors: [{ name: "x", provider: "copilot-api", model: "claude-haiku-4.5", instructions: "check" }]
      })
    );
    assert.throws(() =>
      validateConfig({
        ...baseConfig(),
        providers: {
          loopback: {
            kind: "api",
            provider: "openai-compatible",
            apiKeyEnv: "SMOKE_KEY"
          }
        },
        advisors: [{ name: "x", provider: "loopback", model: "m", instructions: "check" }]
      })
    );
  });

  it("accepts empty version-2 collections and still rejects empty version-1", () => {
    const parsed = validateConfig({ version: 2, providers: {}, advisors: [] });
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.providers, {});
    assert.deepEqual(parsed.advisors, []);
    assert.throws(() => validateConfig({ version: 1, providers: {}, advisors: [] }));
  });


  it("preserves explicit version-2 enabled and reasoning effort", () => {
    const parsed = validateConfig({
      version: 2,
      providers: {
        "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
      },
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-4.1",
          instructions: "Look for observable correctness failures.",
          enabled: false,
          reasoningEffort: "default"
        }
      ]
    });
    assert.equal(parsed.advisors[0].enabled, false);
    assert.equal(parsed.advisors[0].reasoningEffort, "default");
    assert.equal(parsed.advisors[0].name, "correctness");
    assert.equal(parsed.advisors[0].model, "gpt-4.1");
  });

  it("rejects unknown provider references and unknown future versions", () => {
    assert.throws(() =>
      validateConfig({
        version: 2,
        providers: {},
        advisors: [
          {
            name: "correctness",
            provider: "openai-api",
            model: "gpt-4.1",
            instructions: "Look for observable correctness failures.",
            enabled: true,
            reasoningEffort: "default"
          }
        ]
      })
    );
    assert.throws(() => validateConfig({ version: 3, providers: {}, advisors: [] }));
  });

  it("rejects unpaired or malformed compatible reasoning format and map", () => {
    const thinkingLevelMap = {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null
    };
    const compatible = (models) =>
      validateConfig({
        version: 2,
        providers: {
          loopback: {
            kind: "api",
            provider: "openai-compatible",
            apiKeyEnv: "SMOKE_KEY",
            baseUrl: "http://127.0.0.1:8765/v1",
            models
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
      });
    const ok = compatible({
      "smoke-model": {
        contextWindow: 32000,
        maxTokens: 2048,
        reasoning: true,
        input: ["text"],
        thinkingFormat: "openai",
        thinkingLevelMap
      }
    });
    assert.equal(ok.providers.loopback.models["smoke-model"].thinkingFormat, "openai");
    assert.equal("supportsReasoningEffort" in ok.providers.loopback.models["smoke-model"], false);
    assert.equal(ok.providers.loopback.models["smoke-model"].thinkingLevelMap.high, "high");
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingFormat: "openai"
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingLevelMap
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingFormat: "anthropic",
          thinkingLevelMap
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingFormat: "openai",
          thinkingLevelMap: { ...thinkingLevelMap, extra: "high" }
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingFormat: "openai",
          thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null }
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          contextWindow: 32000,
          maxTokens: 2048,
          reasoning: true,
          input: ["text"],
          thinkingFormat: "openai",
          thinkingLevelMap: { ...thinkingLevelMap, high: 1 }
        }
      })
    );
  });

  it("accepts optional supportsReasoningEffort only with a complete thinking pair", () => {
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
    const compatible = (models, version = 2) =>
      validateConfig({
        version,
        providers: {
          loopback: {
            kind: "api",
            provider: "openai-compatible",
            apiKeyEnv: "SMOKE_KEY",
            baseUrl: "http://127.0.0.1:8765/v1",
            models
          }
        },
        advisors: [
          {
            name: "smoke",
            provider: "loopback",
            model: "smoke-model",
            instructions: "Inspect the fixture.",
            ...(version === 2 ? { enabled: true, reasoningEffort: "default" } : {})
          }
        ]
      });
    const baseMeta = {
      contextWindow: 32000,
      maxTokens: 2048,
      reasoning: true,
      input: ["text"]
    };
    const native = compatible({
      "smoke-model": {
        ...baseMeta,
        thinkingFormat: "openai",
        thinkingLevelMap,
        supportsReasoningEffort: true
      }
    });
    assert.equal(native.providers.loopback.models["smoke-model"].supportsReasoningEffort, true);
    const enableOnly = compatible({
      "smoke-model": {
        ...baseMeta,
        thinkingFormat: "zai",
        thinkingLevelMap: zaiMap,
        supportsReasoningEffort: false
      }
    });
    assert.equal(enableOnly.providers.loopback.models["smoke-model"].supportsReasoningEffort, false);
    assert.equal(enableOnly.providers.loopback.models["smoke-model"].thinkingFormat, "zai");
    assert.throws(() =>
      compatible({
        "smoke-model": { ...baseMeta, supportsReasoningEffort: true }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          ...baseMeta,
          thinkingFormat: "openai",
          supportsReasoningEffort: true
        }
      })
    );
    assert.throws(() =>
      compatible({
        "smoke-model": {
          ...baseMeta,
          thinkingFormat: "openai",
          thinkingLevelMap,
          supportsReasoningEffort: "true"
        }
      })
    );
    assert.throws(() =>
      compatible(
        {
          "smoke-model": { ...baseMeta, supportsReasoningEffort: false }
        },
        1
      )
    );
  });

});

describe("loadConfig", () => {
  it("loads from CLAUDE_CONFIG_DIR, normalizes version-1 in memory, and does not rewrite the file", async () => {
    const dir = await scratch("cma-cfg-");
    const file = path.join(dir, "cross-model-advisor.json");
    const body = `${JSON.stringify(baseConfig())}\n`;
    await fs.writeFile(file, body);
    const loaded = await loadConfig({ env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(loaded.version, 2);
    assert.equal(loaded.advisors[0].name, "correctness");
    assert.equal(loaded.advisors[0].enabled, true);
    assert.equal(loaded.advisors[0].reasoningEffort, "default");
    assert.equal(Object.hasOwn(loaded.providers["openai-api"], "apiKeyEnv"), true);
    assert.equal(Object.values(loaded.providers).some((entry) => "apiKey" in entry), false);
    assert.equal(await fs.readFile(file, "utf8"), body);
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(Object.hasOwn(onDisk.advisors[0], "enabled"), false);
    assert.equal(Object.hasOwn(onDisk.advisors[0], "reasoningEffort"), false);
    const empty = await scratch("cma-cfg-missing-");
    await assert.rejects(() => loadConfig({ env: { CLAUDE_CONFIG_DIR: empty } }));
  });
});

describe("validateRoot and runtimeErrors", () => {
  it("refuses filesystem root, home, and missing paths", async () => {
    const dir = await scratch("cma-root-");
    const canonical = await validateRoot(dir);
    assert.equal(canonical, await fs.realpath(dir));
    const snap = await snapshotRoot(dir);
    assert.equal(snap.path, canonical);
    assert.equal(typeof snap.dev !== "undefined", true);
    assert.equal(typeof snap.ino !== "undefined", true);
    await assert.rejects(() => validateRoot("/"));
    await assert.rejects(() => validateRoot(os.homedir()));
    await assert.rejects(() => validateRoot(path.join(dir, "missing")));
  });

  it("reports runtime diagnostics as an array", () => {
    const errors = runtimeErrors({});
    assert.equal(Array.isArray(errors), true);
    assert.equal(errors.length, 0);
  });
});

describe("createReviewTools confinement", () => {
  async function project() {
    const root = await scratch("cma-proj-");
    await fs.writeFile(path.join(root, "ok.js"), "const x = 1;\nconst y = 2;\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET_TOKEN=should-not-leak\n");
    await fs.writeFile(path.join(root, "note.pem"), "PEM_SENTINEL\n");
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.js"), "export const n = 3;\n");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "MODULE_SENTINEL\n");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(root, "WATCHDOG.md"), "Prefer concrete edge cases.\n");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(path.join(root, "ignored.txt"), "GITIGNORE_SENTINEL\n");
    await fs.writeFile(path.join(root, ".cross-model-advisorignore"), "extra.secret\n!ok.js\n");
    await fs.writeFile(path.join(root, "extra.secret"), "PROJECT_IGNORE_SENTINEL\n");
    return root;
  }

  it("rejects traversal, outside paths, symlinks, ignored names, binary, and oversized files", async () => {
    const root = await project();
    const outside = path.join(path.dirname(root), `cma-outside-${path.basename(root)}`);
    await fs.writeFile(outside, "OUTSIDE_SENTINEL\n");
    scratchDirs.push(outside);
    await fs.symlink(outside, path.join(root, "link-out"));
    const escapeDir = await scratch("cma-escape-");
    await fs.writeFile(path.join(escapeDir, "secret.txt"), "LINK_PARENT_SENTINEL\n");
    await fs.symlink(escapeDir, path.join(root, "via"));
    await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0x00, 0x61, 0x62, 0x63, 0x53, 0x45, 0x4e]));
    const big = Buffer.alloc(1024 * 1024 + 8, 0x61);
    Buffer.from("BIGFILE!").copy(big, 0);
    await fs.writeFile(path.join(root, "huge.txt"), big);

    const tools = await createReviewTools({
      root,
      observations: [{ eventId: "obs_1" }]
    });

    const leaks = [
      await tools.call("read", { path: "../" + path.basename(outside) }),
      await tools.call("read", { path: outside }),
      await tools.call("read", { path: "link-out" }),
      await tools.call("read", { path: "via/secret.txt" }),
      await tools.call("read", { path: ".env" }),
      await tools.call("read", { path: "note.pem" }),
      await tools.call("read", { path: "ignored.txt" }),
      await tools.call("read", { path: "extra.secret" }),
      await tools.call("read", { path: "node_modules/pkg/index.js" }),
      await tools.call("read", { path: ".git/HEAD" }),
      await tools.call("read", { path: "bin.dat" }),
      await tools.call("read", { path: "huge.txt" }),
      await tools.call("search", { query: "SECRET_TOKEN" }),
      await tools.call("search", { query: "GITIGNORE_SENTINEL" }),
      await tools.call("search", { query: "PROJECT_IGNORE_SENTINEL" }),
      await tools.call("search", { query: "MODULE_SENTINEL" }),
      await tools.call("list", { path: ".", depth: 2 })
    ];
    const joined = leaks.map((item) => String(item)).join("\n");
    for (const sentinel of [
      "OUTSIDE_SENTINEL",
      "LINK_PARENT_SENTINEL",
      "should-not-leak",
      "PEM_SENTINEL",
      "GITIGNORE_SENTINEL",
      "PROJECT_IGNORE_SENTINEL",
      "MODULE_SENTINEL",
      "BIGFILE!"
    ]) {
      assert.equal(joined.includes(sentinel), false, sentinel);
    }
    const names = listingNames(leaks.at(-1));
    assert.equal(names.includes(".env"), false);
    assert.equal(names.includes("ignored.txt"), false);
    assert.equal(names.includes("extra.secret"), false);
    assert.equal(names.includes("node_modules"), false);
    assert.equal(names.includes(".git"), false);
    assert.equal(names.includes("ok.js"), true);
    const allowed = await tools.call("read", { path: "ok.js" });
    assert.equal(String(allowed).includes("const x = 1;"), true);
    assert.equal(tools.guidance.includes("concrete edge cases"), true);
  });

  it("does not reopen hard excludes via gitignore negation", async () => {
    const root = await scratch("cma-neg-");
    await fs.writeFile(path.join(root, ".gitignore"), "!.env\n");
    await fs.writeFile(path.join(root, ".env"), "HARD_ENV_SENTINEL\n");
    await fs.writeFile(path.join(root, "ok.js"), "const ok = true;\n");
    const tools = await createReviewTools({ root });
    const result = await tools.call("read", { path: ".env" });
    assert.equal(String(result).includes("HARD_ENV_SENTINEL"), false);
    const listing = listingNames(await tools.call("list", {}));
    assert.equal(listing.includes(".env"), false);
  });

  it("blocks a custom in-project credential dir even before it exists", async () => {
    const root = await scratch("cma-cred-");
    await fs.writeFile(path.join(root, "ok.js"), "const ok = true;\n");
    await fs.writeFile(path.join(root, ".gitignore"), "!settings/\n!settings/**\n");
    const credentialDir = path.join(root, "settings", "cross-model-advisor", "credentials");
    const tools = await createReviewTools({ root, credentialDir });
    await fs.mkdir(credentialDir, { recursive: true });
    await fs.writeFile(path.join(credentialDir, "slot.json"), "REFRESH_TOKEN_SENTINEL\n");
    const joined = [
      await tools.call("read", { path: "settings/cross-model-advisor/credentials/slot.json" }),
      await tools.call("list", { path: "settings/cross-model-advisor/credentials" }),
      await tools.call("search", { query: "REFRESH_TOKEN_SENTINEL" })
    ]
      .map((item) => String(item))
      .join("\n");
    assert.equal(joined.includes("REFRESH_TOKEN_SENTINEL"), false);

    const rootCred = await scratch("cma-cred-root-");
    await fs.writeFile(path.join(rootCred, "ok.js"), "SOURCE_SENTINEL\n");
    const blocked = await createReviewTools({ root: rootCred, credentialDir: rootCred });
    const source = String(await blocked.call("read", { path: "ok.js" }));
    assert.equal(source.includes("SOURCE_SENTINEL"), false);
  });

  it("rejects fabricated evidence, content-free notes, unknown observations, and a second advise", async () => {
    const root = await project();
    const tools = await createReviewTools({
      root,
      observations: [{ eventId: "obs_1" }],
      advisor: { name: "correctness" }
    });
    await tools.call("advise", {
      severity: "concern",
      note: "ok.js never checks empty input before parsing.",
      evidence: [{ kind: "file", path: "ok.js", line: 1, detail: "const x = 1;" }]
    });
    assert.equal(tools.candidate, null);

    await tools.call("advise", {
      severity: "concern",
      note: "thanks",
      evidence: [{ kind: "observation", eventId: "obs_1", detail: "user asked for review" }]
    });
    assert.equal(tools.candidate, null);

    await tools.call("advise", {
      severity: "concern",
      note: "The session ignored a missing null check.",
      evidence: [{ kind: "observation", eventId: "obs_999", detail: "not supplied" }]
    });
    assert.equal(tools.candidate, null);

    await tools.call("read", { path: "ok.js" });
    const staged = await tools.call("advise", {
      severity: "concern",
      note: "ok.js never checks empty input before parsing.",
      evidence: [{ kind: "file", path: "ok.js", line: 1, detail: "const x = 1;", hash: "00".repeat(32) }]
    });
    void staged;
    assert.equal(tools.candidate, null);

    const accepted = await tools.call("advise", {
      severity: "concern",
      note: "ok.js never checks empty input before parsing.",
      evidence: [{ kind: "file", path: "ok.js", line: 1, detail: "const x = 1;" }]
    });
    assert.equal(accepted, "staged");
    assert.equal(tools.candidate.severity, "concern");
    assert.equal(tools.candidate.evidence[0].kind, "file");
    assert.equal(typeof tools.candidate.evidence[0].hash, "string");
    assert.equal(tools.candidate.evidence[0].hash.length, 64);
    const firstHash = tools.candidate.evidence[0].hash;

    await tools.call("advise", {
      severity: "blocker",
      note: "A second finding must not replace the staged candidate.",
      evidence: [{ kind: "file", path: "ok.js", line: 2, detail: "const y = 2;" }]
    });
    assert.equal(tools.candidate.severity, "concern");
    assert.equal(tools.candidate.evidence[0].hash, firstHash);

    assert.equal(await tools.isFresh(tools.candidate), true);
    await fs.writeFile(path.join(root, "ok.js"), "const x = 1;\nconst y = 3;\n");
    assert.equal(await tools.isFresh(tools.candidate), false);
  });

  it("redacts configured secrets from tool output and does not treat advise as published", async () => {
    const root = await scratch("cma-secret-");
    await fs.writeFile(path.join(root, "src.js"), 'const token = "abcd-live-secret";\n');
    const tools = await createReviewTools({ root, secrets: ["abcd-live-secret"] });
    const body = await tools.call("read", { path: "src.js" });
    assert.equal(String(body).includes("abcd-live-secret"), false);
    assert.equal(String(body).includes("[redacted]"), true);
    await tools.call("advise", {
      severity: "nit",
      note: "The token is hardcoded in src.js and should be read from the environment.",
      evidence: [{ kind: "file", path: "src.js", line: 1, detail: "hardcoded token" }]
    });
    assert.equal(tools.candidate !== null, true);
  });

  it("rejects case-aliased hard excludes", async () => {
    const root = await scratch("cma-case-");
    await fs.writeFile(path.join(root, ".ENV"), "ENV_CASE_SENTINEL\n");
    await fs.mkdir(path.join(root, ".CLAUDE"));
    await fs.writeFile(path.join(root, ".CLAUDE", "settings.json"), "CLAUDE_CASE_SENTINEL\n");
    await fs.writeFile(path.join(root, "secret.PEM"), "PEM_CASE_SENTINEL\n");
    await fs.writeFile(path.join(root, "ok.js"), "const ok = true;\n");
    const tools = await createReviewTools({ root });
    const joined = [
      await tools.call("read", { path: ".ENV" }),
      await tools.call("read", { path: ".env" }),
      await tools.call("read", { path: ".CLAUDE/settings.json" }),
      await tools.call("read", { path: ".claude/settings.json" }),
      await tools.call("read", { path: "secret.PEM" }),
      await tools.call("list", {})
    ]
      .map((item) => String(item))
      .join("\n");
    assert.equal(joined.includes("ENV_CASE_SENTINEL"), false);
    assert.equal(joined.includes("CLAUDE_CASE_SENTINEL"), false);
    assert.equal(joined.includes("PEM_CASE_SENTINEL"), false);
  });

  it("does not load excluded WATCHDOG.md as guidance", async () => {
    const root = await scratch("cma-wd-");
    await fs.writeFile(path.join(root, "WATCHDOG.md"), "SHOULD_NOT_GUIDE\n");
    await fs.writeFile(path.join(root, "ok.js"), "const ok = true;\n");
    const ignored = await createReviewTools({ root, exclude: ["WATCHDOG.md"] });
    assert.equal(ignored.guidance.includes("SHOULD_NOT_GUIDE"), false);
    const giRoot = await scratch("cma-wd-gi-");
    await fs.writeFile(path.join(giRoot, ".gitignore"), "WATCHDOG.md\n");
    await fs.writeFile(path.join(giRoot, "WATCHDOG.md"), "SHOULD_NOT_GUIDE\n");
    await fs.writeFile(path.join(giRoot, "ok.js"), "const ok = true;\n");
    const giTools = await createReviewTools({ root: giRoot });
    assert.equal(giTools.guidance.includes("SHOULD_NOT_GUIDE"), false);
  });

  it("records only fully displayed lines as evidence and caps UTF-8 bytes", async () => {
    const root = await scratch("cma-trunc-");
    const line1 = "A".repeat(70_000);
    await fs.writeFile(path.join(root, "wide.js"), `${line1}\nLINE2_UNIQUE\n`);
    const tools = await createReviewTools({ root });
    const body = String(await tools.call("read", { path: "wide.js" }));
    assert.equal(body.includes("LINE2_UNIQUE"), false);
    assert.equal(Buffer.byteLength(body, "utf8") <= 64 * 1024, true);
    await tools.call("advise", {
      severity: "concern",
      note: "The second line of wide.js is unreachable after truncation.",
      evidence: [{ kind: "file", path: "wide.js", line: 2, detail: "LINE2_UNIQUE" }]
    });
    assert.equal(tools.candidate, null);
    await tools.call("advise", {
      severity: "concern",
      note: "The first line of wide.js was not fully returned.",
      evidence: [{ kind: "file", path: "wide.js", line: 1, detail: "oversized line" }]
    });
    assert.equal(tools.candidate, null);

    const cjkRoot = await scratch("cma-cjk-");
    await fs.writeFile(path.join(cjkRoot, "cjk.txt"), `${"你".repeat(30_000)}\n`);
    const cjkTools = await createReviewTools({ root: cjkRoot });
    const cjkBody = String(await cjkTools.call("read", { path: "cjk.txt" }));
    assert.equal(Buffer.byteLength(cjkBody, "utf8") <= 64 * 1024, true);
  });

  it("fail-closes truncated ignore files and honors nested gitignore un-ignores", async () => {
    const overflow = await scratch("cma-ig-over-");
    const gi = Buffer.alloc(256 * 1024 + 32, 0x23);
    Buffer.from("\nprivate.txt\n").copy(gi, 256 * 1024);
    await fs.writeFile(path.join(overflow, ".gitignore"), gi);
    await fs.writeFile(path.join(overflow, "private.txt"), "TAIL_IGNORE_SENTINEL\n");
    await fs.writeFile(path.join(overflow, "ok.js"), "const ok = true;\n");
    const overTools = await createReviewTools({ root: overflow });
    const leaked = String(await overTools.call("read", { path: "private.txt" }));
    assert.equal(leaked.includes("TAIL_IGNORE_SENTINEL"), false);

    const nested = await scratch("cma-ig-nest-");
    await fs.writeFile(path.join(nested, ".gitignore"), "*.txt\n");
    await fs.mkdir(path.join(nested, "src"));
    await fs.writeFile(path.join(nested, "src", ".gitignore"), "!keep.txt\n");
    await fs.writeFile(path.join(nested, "src", "keep.txt"), "NESTED_KEEP\n");
    await fs.writeFile(path.join(nested, "drop.txt"), "NESTED_DROP\n");
    const nestTools = await createReviewTools({ root: nested });
    const keep = String(await nestTools.call("read", { path: "src/keep.txt" }));
    const drop = String(await nestTools.call("read", { path: "drop.txt" }));
    assert.equal(keep.includes("NESTED_KEEP"), true);
    assert.equal(drop.includes("NESTED_DROP"), false);
  });

  it("excludes every path git ignores, not only .gitignore matches", async () => {
    const root = await scratch("cma-gitignored-");
    await fs.writeFile(path.join(root, "app.js"), "ok\n");
    await fs.writeFile(path.join(root, "local-secrets.yml"), "INFO_EXCLUDE_SENTINEL\n");
    await fs.mkdir(path.join(root, "cache"));
    await fs.writeFile(path.join(root, "cache", "dump.txt"), "IGNORED_DIR_SENTINEL\n");
    const tools = await createReviewTools({ root, ignoredPaths: ["local-secrets.yml", "cache/"] });
    assert.match(await tools.call("read", { path: "local-secrets.yml" }), /^Error:/);
    assert.match(await tools.call("read", { path: "cache/dump.txt" }), /^Error:/);
    assert.equal(await tools.call("list", {}), "app.js");
    assert.doesNotMatch(await tools.call("search", { query: "SENTINEL" }), /SENTINEL/);
    assert.equal(await tools.excluded("cache/dump.txt"), true);
  });

  it("excludes common credential files by name", async () => {
    const root = await scratch("cma-credfiles-");
    const names = [".npmrc", ".netrc", ".envrc", ".pypirc", ".git-credentials", "id_ed25519", "id_rsa", "cert.p12", "store.jks"];
    for (const name of names) await fs.writeFile(path.join(root, name), "CREDENTIAL_SENTINEL\n");
    await fs.mkdir(path.join(root, ".ssh"));
    await fs.writeFile(path.join(root, ".ssh", "config"), "CREDENTIAL_SENTINEL\n");
    await fs.writeFile(path.join(root, "id_rsa.pub"), "public key is fine\n");
    const tools = await createReviewTools({ root });
    for (const name of [...names, ".ssh/config"]) {
      assert.match(await tools.call("read", { path: name }), /^Error:/, name);
    }
    assert.match(await tools.call("read", { path: "id_rsa.pub" }), /public key is fine/);
  });

  it("redacts environment-style and well-known tokens but leaves ordinary code readable", async () => {
    const root = await scratch("cma-redact-");
    await fs.writeFile(
      path.join(root, "setup.sh"),
      [
        "export GITHUB_TOKEN=ghp_short456",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG",
        "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "const MAX_TOKENS = 1500;",
        "const secretList = secrets.filter(Boolean);",
        "DB_PASSWORD=hunter2",
        "NPM_TOKEN=12345678",
        "TOKEN_LIMIT = 4096",
        "if (GITHUB_TOKEN === undefined) fail();",
        ""
      ].join("\n")
    );
    const body = await (await createReviewTools({ root })).call("read", { path: "setup.sh" });
    assert.doesNotMatch(body, /ghp_short456|wJalrXUtnFEMIK7MDENG|ghp_abcdefghij|hunter2|12345678/);
    assert.match(body, /GITHUB_TOKEN=\[redacted\]/);
    assert.match(body, /DB_PASSWORD=\[redacted\]/);
    assert.match(body, /MAX_TOKENS = 1500;/);
    assert.match(body, /TOKEN_LIMIT = 4096/);
    assert.match(body, /if \(GITHUB_TOKEN === undefined\) fail\(\);/);
    assert.match(body, /const secretList = secrets\.filter\(Boolean\);/);
  });

  it("lines from a withdrawn read stop counting as evidence", async () => {
    const root = await scratch("cma-withdraw-");
    await fs.writeFile(path.join(root, "a.js"), "one\ntwo\nthree\n");
    const tools = await createReviewTools({ root, maxFindings: 5 });
    const cite = (line) =>
      tools.call("advise", { severity: "nit", note: `line ${line} is odd`, evidence: [{ kind: "file", path: "a.js", line, detail: "seen" }] });
    await tools.call("read", { path: "a.js", limit: 1 });
    await tools.call("read", { path: "a.js", offset: 2, limit: 2 });
    tools.withdrawLastResult();
    assert.equal(await cite(2), "Error: invalid evidence");
    assert.equal(await cite(1), "staged");
    tools.withdrawLastResult();
    assert.equal(await cite(1), "Error: duplicate finding");
  });

  it("rejects a replaced project root when activation identity is pinned", async () => {
    const root = await scratch("cma-ident-");
    await fs.writeFile(path.join(root, "ok.js"), "ORIGINAL_ROOT\n");
    const snap = await snapshotRoot(root);
    const tools = await createReviewTools({
      root: snap.path,
      rootIdent: { dev: snap.dev, ino: snap.ino }
    });
    const moved = `${root}.old`;
    await fs.rename(root, moved);
    scratchDirs.push(moved);
    await fs.mkdir(root);
    scratchDirs.push(root);
    await fs.writeFile(path.join(root, "ok.js"), "REPLACED_ROOT\n");
    const fromLive = String(await tools.call("read", { path: "ok.js" }));
    assert.equal(fromLive.includes("REPLACED_ROOT"), false);
    await assert.rejects(() =>
      createReviewTools({ root, rootIdent: { dev: snap.dev, ino: snap.ino } })
    );
  });
});

describe("normalizeFinding", () => {
  it("normalizes whitespace and case", () => {
    assert.equal(normalizeFinding("  Hello\nWorld "), "hello world");
  });
  it("ignores markdown and sentence punctuation but not code", () => {
    assert.equal(normalizeFinding("`items[i]` reads past the end, so use `i - 1`."), normalizeFinding("items[i] reads past the end so use i - 1"));
    assert.notEqual(normalizeFinding("use `i < n`"), normalizeFinding("use `i > n`"));
    assert.equal(normalizeFinding("use `obj.prop` or 1.5"), "use obj.prop or 1.5");
  });
});
