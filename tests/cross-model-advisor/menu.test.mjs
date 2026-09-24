/**
 * Terminal menu workflow regressions. Injected UI drives runSetupMenu;
 * quoting and no-TTY use the bundled CLI. Assertions cover disk, live
 * session snapshots, and auth/TTY side effects — not mock echoes.
 *
 *   node --test tests/cross-model-advisor/menu.test.mjs
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  configV2,
  posixQuote,
  runSetupCli,
  SETUP_HELPER,
  thinkingMap
} from "./fixtures/terminal-smoke.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distModules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const load = (rel) => import(pathToFileURL(path.join(distModules, rel)).href);

const { runSetupMenu } = await load("setup-menu.mjs");
const { getModels } = await load("setup-store.mjs");

const scratchDirs = [];

after(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function dumpItems(opts) {
  const items = (opts.items ?? []).map((item) => `${item.value}:${item.label}`).join(" | ");
  return `${opts.title}\n${items}`;
}

function pick(items, pattern) {
  const hit = (items ?? []).find((item) => {
    const hay = `${item.value ?? ""} ${item.label ?? ""} ${item.description ?? ""}`;
    return typeof pattern === "string" ? hay.includes(pattern) : pattern.test(hay);
  });
  if (!hit) {
    throw new Error(`no item matching ${pattern} in ${(items ?? []).map((item) => item.label).join(" | ")}`);
  }
  return hit;
}

function select(items, pattern) {
  return { action: "select", value: pick(items, pattern).value };
}

function isHome(opts) {
  return opts.toggle === true && String(opts.title ?? "").startsWith("Cross-model advisors");
}

function isEditor(opts) {
  return /^Advisor /.test(String(opts.title ?? ""));
}


async function makeWorld(prefix = "cma-menu-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}root-`)));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}data-`)));
  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}cfg-`)));
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}home-`)));
  scratchDirs.push(root, data, configDir, home);
  const configFile = path.join(configDir, "cross-model-advisor.json");
  const sessionId = `menu-${randomUUID().slice(0, 8)}`;
  return { root, data, configDir, home, configFile, sessionId };
}

function sessionEnv(world, extra = {}) {
  return {
    CMA_SMOKE_API_KEY: "sk-smoke-not-a-real-key",
    CLAUDE_PLUGIN_DATA: world.data,
    CLAUDE_PROJECT_DIR: world.root,
    CLAUDE_CODE_SESSION_ID: extra.sessionId ?? world.sessionId,
    CLAUDE_SESSION_ID: extra.sessionId ?? world.sessionId,
    CLAUDE_CONFIG_DIR: world.configDir,
    HOME: world.home,
    ...extra.env
  };
}

async function writeConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(file, body, { mode: 0o600 });
  return createHash("sha256").update(body).digest("hex");
}

async function readConfig(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function fakeIo() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.isTTY = true;
  stdout.isTTY = true;
  stdin.setRawMode = () => {};
  return { stdin, stdout };
}

function scriptedUi(handler) {
  const notices = [];
  let closed = 0;
  let suspends = 0;
  let reacquires = 0;
  let calls = 0;
  const ui = {
    notices,
    get closed() {
      return closed;
    },
    get suspends() {
      return suspends;
    },
    get reacquires() {
      return reacquires;
    },
    async choose(opts) {
      calls += 1;
      if (calls > 80) throw new Error(`too many choose()\n${dumpItems(opts)}`);
      return handler("choose", opts, ui);
    },
    async text(opts) {
      calls += 1;
      if (calls > 80) throw new Error(`too many text()\n${opts.title}`);
      return handler("text", opts, ui);
    },
    async confirm(opts) {
      return handler("confirm", opts, ui);
    },
    async notice(opts) {
      notices.push(opts);
      if (typeof handler.notice === "function") await handler.notice(opts, ui);
    },
    async suspend(fn) {
      suspends += 1;
      try {
        return await fn();
      } finally {
        reacquires += 1;
      }
    },
    close() {
      closed += 1;
    }
  };
  return ui;
}

async function runMenu(world, ui, extra = {}) {
  const io = fakeIo();
  return runSetupMenu({
    env: extra.env ?? sessionEnv(world),
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stdout,
    ui,
    ...extra
  });
}

function advisorNamed(rows, name) {
  return (rows ?? []).find((row) => row.name === name);
}

test("v1 config opens without mutation and explicit save writes v2", async () => {
  const world = await makeWorld("cma-v1-");
  const v1 = {
    version: 1,
    providers: {
      "codex-login": { kind: "oauth", provider: "openai-codex" }
    },
    advisors: [
      {
        name: "architecture",
        provider: "codex-login",
        model: "gpt-5",
        instructions: "Look for avoidable complexity."
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
  await writeConfig(world.configFile, v1);
  const before = await fs.readFile(world.configFile, "utf8");
  const ui = scriptedUi((kind, opts) => {
    if (kind === "choose" && isHome(opts)) return { action: "select", value: "Quit" };
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui);
  assert.equal(await fs.readFile(world.configFile, "utf8"), before);
  assert.equal((await readConfig(world.configFile)).version, 1);

  const saveUi = scriptedUi((kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      if (!saveUi._saved) {
        saveUi._saved = true;
        return select(opts.items, "Save");
      }
      return select(opts.items, "Quit");
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, saveUi);
  const written = await readConfig(world.configFile);
  assert.equal(written.version, 2);
  assert.equal(written.advisors[0].enabled, true);
  assert.equal(written.advisors[0].reasoningEffort, "default");
  assert.deepEqual(written.exclude, ["tmp/**"]);
  assert.ok(saveUi.notices.some((note) => note.title === "Saved"));
});

test("luna model and high effort are saved from the advisor editor", async () => {
  const world = await makeWorld("cma-luna-");
  await writeConfig(world.configFile, configV2());
  const ui = scriptedUi(async (kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      // Saved settings apply at the next reviewed turn; the menu names no session.
      assert.ok(!opts.items.some((item) => /Apply|Enable/.test(item.label)));
      if (!ui._edited) {
        ui._edited = true;
        return select(opts.items, "architecture");
      }
      if (!ui._saved) {
        ui._saved = true;
        return select(opts.items, "Save");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && isEditor(opts)) {
      if (!ui._model) {
        ui._model = true;
        return select(opts.items, "Model");
      }
      if (!ui._effort) {
        ui._effort = true;
        return select(opts.items, "Reasoning effort");
      }
      return null;
    }
    if (kind === "choose" && opts.load && /Model/.test(opts.title)) {
      const page = await opts.load({ query: "luna", offset: 0, limit: 40 });
      const hit = page.items.find((item) => item.value === "gpt-5.6-luna" || /luna/i.test(item.label));
      assert.ok(hit, `luna missing from ${page.items.map((item) => item.value).join(",")}`);
      return { action: "select", value: hit.value };
    }
    if (kind === "choose" && /Reasoning effort/.test(opts.title)) {
      return select(opts.items, /^High$|High/);
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui);
  const written = await readConfig(world.configFile);
  const architecture = advisorNamed(written.advisors, "architecture");
  assert.equal(architecture.model, "gpt-5.6-luna");
  assert.equal(architecture.reasoningEffort, "high");
  assert.deepEqual(written.exclude, ["tmp/**"]);
  assert.ok(ui.notices.some((note) => note.title === "Saved"));
});

test("discard on dirty cancel leaves disk unchanged", async () => {
  const world = await makeWorld("cma-cancel-");
  const revision = await writeConfig(world.configFile, configV2());
  const ui = scriptedUi(async (kind, opts) => {
    if (kind === "choose" && isHome(opts)) return null;
    if (kind === "choose" && /Unsaved changes/.test(opts.title)) return select(opts.items, "Discard");
    if (kind === "choose" && isEditor(opts)) {
      if (!ui._model) {
        ui._model = true;
        return select(opts.items, "Model");
      }
      return null;
    }
    if (kind === "choose" && opts.load && /Model/.test(opts.title)) {
      const page = await opts.load({ query: "luna", offset: 0, limit: 40 });
      return { action: "select", value: page.items.find((item) => item.value === "gpt-5.6-luna").value };
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui);
  assert.equal(createHash("sha256").update(await fs.readFile(world.configFile)).digest("hex"), revision);
  assert.equal((await readConfig(world.configFile)).advisors[0].model, "gpt-5");
});

test("non-TTY menu prints the launcher and writes nothing", async () => {
  const world = await makeWorld("cma-notty-");
  const revision = await writeConfig(world.configFile, configV2());
  const env = sessionEnv(world);
  const result = await runSetupCli(["menu"], env, { cwd: world.root, timeoutMs: 6_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Open this menu in your own terminal/);
  assert.match(result.stderr, /CLAUDE_CONFIG_DIR=/);
  assert.doesNotMatch(result.stderr, /CLAUDE_PLUGIN_DATA|SESSION_ID/);
  assert.doesNotMatch(result.stderr, /menu-command/);
  assert.equal(createHash("sha256").update(await fs.readFile(world.configFile)).digest("hex"), revision);
});

test("space toggle, multi-provider add, last advisor removal, and literal instructions", async () => {
  const world = await makeWorld("cma-edit-");
  const literal = "line1\nline2 café 你好\nkeep <raw> & \\paths";
  await writeConfig(
    world.configFile,
    configV2({
      advisors: [
        {
          name: "architecture",
          provider: "codex-login",
          model: "gpt-5",
          instructions: "old instructions",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    })
  );
  const ui = scriptedUi(async (kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      if (!ui._toggled) {
        ui._toggled = true;
        return { action: "toggle", value: "architecture" };
      }
      if (!ui._providers) {
        ui._providers = true;
        return select(opts.items, "Provider accounts");
      }
      if (!ui._instructions) {
        ui._instructions = true;
        return select(opts.items, "architecture");
      }
      if (!ui._savedOnce) {
        ui._savedOnce = true;
        return select(opts.items, "Save");
      }
      if (!ui._removed) {
        const saved = await readConfig(world.configFile);
        assert.equal(saved.advisors[0].instructions, literal);
        assert.equal(saved.advisors[0].enabled, false);
        ui._removed = true;
        return select(opts.items, "architecture");
      }
      if (!ui._savedEmpty) {
        ui._savedEmpty = true;
        return select(opts.items, "Save");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && opts.title === "Provider accounts") {
      if (!ui._addProviders) {
        ui._addProviders = true;
        return select(opts.items, "Add providers");
      }
      return null;
    }
    if (kind === "choose" && opts.multiple && /Upstream providers/.test(opts.title)) {
      return {
        action: "select",
        values: [pick(opts.items, "openai").value, pick(opts.items, "anthropic").value]
      };
    }
    if (kind === "choose" && /auth/.test(opts.title)) {
      return select(opts.items, "API key");
    }
    if (kind === "text" && /Slot id/.test(opts.title)) return opts.value || "slot";
    if (kind === "text" && /apiKeyEnv/.test(opts.title)) return opts.value || "OPENAI_API_KEY";
    if (kind === "choose" && isEditor(opts)) {
      if (!ui._didInstructions) {
        ui._didInstructions = true;
        return select(opts.items, "Instructions");
      }
      if (ui._removed && !ui._didRemove) {
        ui._didRemove = true;
        return select(opts.items, "Remove");
      }
      return null;
    }
    if (kind === "text" && /Instructions/.test(opts.title)) return literal;
    if (kind === "confirm" && /Remove advisor/.test(opts.title)) return true;
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui);
  const written = await readConfig(world.configFile);
  const openai = Object.values(written.providers).find((slot) => slot.provider === "openai");
  const anthropic = Object.values(written.providers).find((slot) => slot.provider === "anthropic");
  assert.ok(openai, `providers ${Object.keys(written.providers)}`);
  assert.ok(anthropic, `providers ${Object.keys(written.providers)}`);
  assert.equal(openai.kind, "api");
  assert.equal(anthropic.kind, "api");
  assert.equal(openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(anthropic.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.ok(written.providers["codex-login"]);
  assert.deepEqual(written.exclude, ["tmp/**"]);
  assert.deepEqual(written.advisors, []);
});

test("model paging uses load offsets and unsupported effort must be reselected", async () => {
  const world = await makeWorld("cma-page-");
  const catalog = Array.from({ length: 45 }, (_, index) => ({
    id: `page-model-${String(index).padStart(2, "0")}`,
    name: `Page model ${index}`
  }));
  const getModelsPaged = async (providerId, options = {}) => {
    if (providerId !== "openai-codex") return getModels(providerId, options);
    const q = options.q ?? null;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    const needle = typeof q === "string" && q.trim() ? q.trim().toLowerCase() : "";
    const filtered = catalog.filter((model) => {
      if (!needle) return true;
      return model.id.toLowerCase().includes(needle) || String(model.name).toLowerCase().includes(needle);
    });
    return {
      ok: true,
      provider: providerId,
      q,
      offset,
      limit,
      total: filtered.length,
      models: filtered.slice(offset, offset + limit)
    };
  };
  const first = await getModelsPaged("openai-codex", { q: null, offset: 0, limit: 20 });
  const second = await getModelsPaged("openai-codex", { q: null, offset: 20, limit: 20 });
  assert.equal(first.models.length, 20);
  assert.equal(second.models.length, 20);
  const paged = second.models.find((model) => !first.models.some((row) => row.id === model.id));
  assert.ok(paged, "bounded catalog did not page");
  assert.equal(
    second.models.some((model) => first.models.some((row) => row.id === model.id)),
    false
  );
  const searched = await getModelsPaged("openai-codex", { q: paged.id, offset: 0, limit: 20 });
  assert.equal(searched.total, 1);
  assert.equal(searched.models[0]?.id, paged.id);
  await writeConfig(
    world.configFile,
    configV2({
      providers: {
        "codex-login": { kind: "oauth", provider: "openai-codex" },
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "CMA_SMOKE_API_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
          models: {
            "model-off": {
              contextWindow: 16_000,
              maxTokens: 2_048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai",
              thinkingLevelMap: thinkingMap()
            },
            "model-no-off": {
              contextWindow: 16_000,
              maxTokens: 2_048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai",
              thinkingLevelMap: thinkingMap({ off: null })
            }
          }
        }
      },
      advisors: [
        {
          name: "architecture",
          provider: "codex-login",
          model: "gpt-5",
          instructions: "Look for avoidable complexity.",
          enabled: true,
          reasoningEffort: "default"
        },
        {
          name: "correctness",
          provider: "loopback",
          model: "model-off",
          instructions: "Look for correctness failures.",
          enabled: true,
          reasoningEffort: "off"
        }
      ]
    })
  );
  const ui = scriptedUi(async (kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      if (!ui._arch) {
        ui._arch = true;
        return select(opts.items, "architecture");
      }
      if (!ui._corr) {
        ui._corr = true;
        return select(opts.items, "correctness");
      }
      if (!ui._triedSave) {
        ui._triedSave = true;
        return select(opts.items, "Save");
      }
      if (!ui._fix) {
        ui._fix = true;
        return select(opts.items, "correctness");
      }
      if (!ui._saved) {
        ui._saved = true;
        return select(opts.items, "Save");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && isEditor(opts) && /architecture/.test(opts.title)) {
      if (!ui._archModel) {
        ui._archModel = true;
        return select(opts.items, "Model");
      }
      return null;
    }
    if (kind === "choose" && isEditor(opts) && /correctness/.test(opts.title)) {
      if (!ui._corrModel) {
        ui._corrModel = true;
        return select(opts.items, "Model");
      }
      if (ui._fix && !ui._corrEffort) {
        ui._corrEffort = true;
        return select(opts.items, "Reasoning effort");
      }
      return null;
    }
    if (kind === "choose" && opts.load && /Model/.test(opts.title) && !ui._paged) {
      ui._paged = true;
      const page = await opts.load({ query: "", offset: 20, limit: 20 });
      assert.equal(page.total, 45);
      const hit = page.items.find((item) => item.value === paged.id);
      assert.ok(hit, `page two missing ${paged.id}`);
      const searchPage = await opts.load({ query: paged.id, offset: 0, limit: 20 });
      assert.equal(searchPage.total, 1);
      assert.equal(searchPage.items[0]?.value, paged.id);
      return { action: "select", value: hit.value };
    }
    if (kind === "choose" && /Model/.test(opts.title) && !opts.load) {
      return select(opts.items, "model-no-off");
    }
    if (kind === "choose" && /Reasoning effort/.test(opts.title)) {
      return select(opts.items, "Default");
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui, { getModels: getModelsPaged });
  assert.ok(ui.notices.some((note) => /reselect reasoning effort/i.test(`${note.title} ${note.text}`)));
  const written = await readConfig(world.configFile);
  assert.equal(advisorNamed(written.advisors, "architecture").model, paged.id);
  assert.equal(advisorNamed(written.advisors, "correctness").model, "model-no-off");
  assert.equal(advisorNamed(written.advisors, "correctness").reasoningEffort, "default");
});

test("revision conflict refuses overwrite and offers reload or discard", async () => {
  const world = await makeWorld("cma-rev-");
  await writeConfig(world.configFile, configV2());
  const outsider = configV2({
    advisors: [
      {
        name: "architecture",
        provider: "codex-login",
        model: "gpt-5",
        instructions: "intervening editor",
        enabled: true,
        reasoningEffort: "default"
      },
      {
        name: "correctness",
        provider: "loopback",
        model: "smoke-model",
        instructions: "Look for observable correctness failures.",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  const ui = scriptedUi(async (kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      if (!ui._edited) {
        ui._edited = true;
        return select(opts.items, "architecture");
      }
      if (!ui._saving) {
        ui._saving = true;
        await writeConfig(world.configFile, outsider);
        return select(opts.items, "Save");
      }
      if (!ui._keptDraft) {
        ui._keptDraft = true;
        const arch = pick(opts.items, "architecture");
        assert.match(`${arch.description}`, /gpt-5\.6-luna/, "Return must keep the in-memory draft");
        return select(opts.items, "Quit");
      }
      if (!ui._afterUnsavedReturn) {
        ui._afterUnsavedReturn = true;
        const arch = pick(opts.items, "architecture");
        assert.match(`${arch.description}`, /gpt-5\.6-luna/);
        await writeConfig(world.configFile, outsider);
        return select(opts.items, "Save");
      }
      if (!ui._afterReload) {
        ui._afterReload = true;
        const arch = pick(opts.items, "architecture");
        assert.doesNotMatch(`${arch.description}`, /gpt-5\.6-luna/);
        return select(opts.items, "architecture");
      }
      if (!ui._quitDirty) {
        ui._quitDirty = true;
        return select(opts.items, "Quit");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && isEditor(opts)) {
      if (!ui._model) {
        ui._model = true;
        return select(opts.items, "Model");
      }
      if (ui._afterReload && !ui._modelAgain) {
        ui._modelAgain = true;
        return select(opts.items, "Model");
      }
      return null;
    }
    if (kind === "choose" && opts.load && /Model/.test(opts.title)) {
      const page = await opts.load({ query: "luna", offset: 0, limit: 40 });
      const hit = page.items.find((item) => item.value === "gpt-5.6-luna");
      assert.ok(hit, "luna missing from catalog search");
      return { action: "select", value: hit.value };
    }
    if (kind === "choose" && /Configuration changed on disk/.test(opts.title)) {
      const labels = (opts.items ?? []).map((item) => item.label).join("\n");
      assert.match(labels, /Reload from disk/);
      assert.match(labels, /Discard/);
      assert.match(labels, /Return/);
      if (!ui._conflictReturn) {
        ui._conflictReturn = true;
        return select(opts.items, "Return");
      }
      ui._conflictReload = true;
      return select(opts.items, "Reload from disk");
    }
    if (kind === "choose" && /Unsaved changes/.test(opts.title)) {
      const labels = (opts.items ?? []).map((item) => item.label).join("\n");
      assert.match(labels, /Discard/);
      assert.match(labels, /Return/);
      if (!ui._unsavedReturn) {
        ui._unsavedReturn = true;
        return select(opts.items, "Return");
      }
      ui._unsavedDiscard = true;
      return select(opts.items, "Discard");
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui);
  const written = await readConfig(world.configFile);
  assert.equal(written.advisors[0].instructions, "intervening editor");
  assert.equal(written.advisors[0].model, "gpt-5");
  assert.ok(ui.notices.some((note) => note.title === "Not saved"));
  assert.equal(ui._conflictReturn, true);
  assert.equal(ui._conflictReload, true);
  assert.equal(ui._unsavedReturn, true);
  assert.equal(ui._unsavedDiscard, true);
});

test("menu-command quotes spaces and apostrophes and never reads secrets", async () => {
  const world = await makeWorld("cma-quote-");
  const configDir = path.join(world.root, "Ada's config dir");
  const pluginData = path.join(world.root, "plugin's data");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(pluginData, { recursive: true });
  const secret = "sk-live-secret-must-not-appear-in-menu-command";
  await writeConfig(path.join(configDir, "cross-model-advisor.json"), configV2({
    advisors: [
      {
        name: "architecture",
        provider: "codex-login",
        model: "gpt-5",
        instructions: secret,
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  }));
  const credDir = path.join(configDir, "cross-model-advisor", "credentials");
  await fs.mkdir(credDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(credDir, "codex-login.json"), `${JSON.stringify({ token: secret })}\n`, { mode: 0o600 });
  await fs.mkdir(path.join(pluginData, "sessions", "sess-quote"), { recursive: true });
  await fs.writeFile(
    path.join(pluginData, "sessions", "sess-quote", "locator.json"),
    `${JSON.stringify({ controlCapability: "cap-secret-value", socketPath: "/tmp/cma.sock" })}\n`
  );
  const env = sessionEnv(world, {
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_CODE_SESSION_ID: "sess-quote",
      CLAUDE_SESSION_ID: "sess-quote",
      CLAUDE_PROJECT_DIR: world.root
    }
  });
  const result = await runSetupCli(["menu-command"], env, { cwd: world.root });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  assert.match(line, / menu$/);
  assert.ok(line.includes(`CLAUDE_CONFIG_DIR=${posixQuote(path.resolve(configDir))}`));
  // The menu edits saved settings only; it names no session.
  assert.doesNotMatch(line, /CLAUDE_PLUGIN_DATA|CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CLAUDE_PROJECT_DIR/);
  const helper = posixQuote(fsSync.realpathSync(SETUP_HELPER));
  assert.ok(line.includes(`node ${helper} menu`));
  assert.doesNotMatch(line, /sk-live-secret|cap-secret-value|controlCapability|architecture/);
  const extra = await runSetupCli(["menu-command", "--plugin-data", pluginData], env, { cwd: world.root });
  assert.notEqual(extra.status, 0);
});

test("oauth login suspends the menu, runs the injected helper, and reacquires", async () => {
  const world = await makeWorld("cma-auth-");
  await writeConfig(world.configFile, configV2());
  const logins = [];
  const ui = scriptedUi((kind, opts) => {
    if (kind === "choose" && isHome(opts)) {
      if (!ui._providers) {
        ui._providers = true;
        return select(opts.items, "Provider accounts");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && opts.title === "Provider accounts") {
      if (!ui._slot) {
        ui._slot = true;
        return select(opts.items, "codex-login");
      }
      return null;
    }
    if (kind === "choose" && /Provider codex-login/.test(opts.title)) {
      if (!ui._login) {
        ui._login = true;
        return select(opts.items, "Login");
      }
      return null;
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  await runMenu(world, ui, {
    login: async (options) => {
      logins.push({ command: options.command, slot: options.slot });
    }
  });
  assert.equal(ui.suspends, 1);
  assert.equal(ui.reacquires, 1);
  assert.deepEqual(logins, [{ command: "login", slot: "codex-login" }]);
  assert.ok(ui.notices.some((note) => /saved slot/i.test(note.text)));
  assert.equal(ui.closed, 0);
});

test("injected close stays idempotent and does not hang deferred work", async () => {
  const world = await makeWorld("cma-close-");
  await writeConfig(world.configFile, configV2());
  const ui = scriptedUi((kind, opts) => {
    if (kind === "choose" && isHome(opts)) return select(opts.items, "Quit");
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  });
  const result = await runMenu(world, ui);
  ui.close();
  ui.close();
  assert.equal(result, 0);
  assert.equal(ui.closed, 2);
});
