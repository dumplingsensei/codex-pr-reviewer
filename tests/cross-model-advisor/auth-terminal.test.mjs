/**
 * Terminal helper regressions: hidden input must not echo, EOF/cancel must
 * reject promptly, select values must be exact, and login hints must name
 * this helper. Imports the bundle. Does not run a real OAuth device flow.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const { AuthError } = await import(pathToFileURL(path.join(modules, "auth.mjs")).href);
const { parseAuthArgv, runAuth } = await import(pathToFileURL(path.join(modules, "auth-control.mjs")).href);

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


function oauthConfig(slot = "codex", provider = "openai-codex") {
  return {
    version: 1,
    providers: {
      [slot]: { kind: "oauth", provider }
    },
    advisors: []
  };
}

function fakeStore() {
  return {
    async list() {
      return [];
    },
    async delete() {},
    async read() {
      return undefined;
    },
    async modify(_id, fn) {
      return fn(undefined);
    }
  };
}

function ttyStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

function collectStdout() {
  const stream = new PassThrough();
  stream.isTTY = true;
  let text = "";
  stream.on("data", (chunk) => {
    text += String(chunk);
  });
  Object.defineProperty(stream, "text", {
    get() {
      return text;
    }
  });
  return stream;
}

async function waitForText(stdout, needle, timeoutMs = 2000) {
  const start = Date.now();
  while (!stdout.text.includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`missing ${JSON.stringify(needle)} in ${JSON.stringify(stdout.text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function loginOpts(overrides = {}) {
  return {
    argv: ["login", "codex"],
    env: { CLAUDE_CONFIG_DIR: "/tmp/cma-auth-terminal-unused" },
    loadConfig: async () => oauthConfig(),
    createCredentialStore: () => fakeStore(),
    createBuiltinProvider: async () => ({ id: "openai-codex", auth: { oauth: {} } }),
    isTTY: true,
    loginTimeoutMs: 4000,
    ...overrides
  };
}

function mixedConfig() {
  return {
    version: 1,
    providers: {
      "xai-api": { kind: "api", provider: "xai", apiKeyEnv: "XAI_API_KEY" },
      "xai-oauth": { kind: "oauth", provider: "xai" }
    },
    advisors: [
      {
        name: "api-reviewer",
        provider: "xai-api",
        model: "grok-3",
        instructions: "SECRET_INSTRUCTIONS_MUST_NOT_LEAK"
      },
      {
        name: "oauth-reviewer",
        provider: "xai-oauth",
        model: "grok-4",
        instructions: "more-secret-instructions"
      }
    ]
  };
}

function refuseAuth() {
  return {
    createCredentialStore() {
      throw new Error("must not read credentials");
    },
    createBuiltinProvider: async () => {
      throw new Error("must not authenticate");
    },
    createModels: async () => {
      throw new Error("must not authenticate");
    }
  };
}

async function runList(overrides = {}) {
  const stdout = collectStdout();
  const stderr = collectStdout();
  const code = await runAuth({
    argv: ["list"],
    env: { CLAUDE_CONFIG_DIR: "/tmp/cma-auth-list-unused", XAI_API_KEY: "sk-live-secret-must-not-leak" },
    stdout,
    stderr,
    loadConfig: async () => mixedConfig(),
    ...refuseAuth(),
    ...overrides
  });
  return { code, stdout, stderr };
}


test("hidden prompts do not echo after a live readline prompt", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const secret = "s3cret-value-do-not-echo";
  const running = runAuth(
    loginOpts({
      stdin,
      stdout,
      stderr: collectStdout(),
      createModels: async () => ({
        setProvider() {},
        async login(_id, _kind, interaction) {
          const account = await interaction.prompt({ message: "Account" });
          const hidden = await interaction.prompt({ type: "secret", message: "Paste token" });
          assert.equal(account.trim(), "ok");
          assert.equal(hidden, secret);
        }
      })
    })
  );
  try {
    await waitForText(stdout, "Account");
    stdin.write("ok\n");
    await waitForText(stdout, "Paste token:");
    stdin.write(`${secret}\r`);
    await running;
  } catch (error) {
    stdin.end();
    await running.catch(() => {});
    throw error;
  }
  assert.doesNotMatch(stdout.text, new RegExp(secret));
});

test("manual_code prompts stay hidden and later text prompts still work", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const code = "abcd-manual-code";
  const running = runAuth(
    loginOpts({
      stdin,
      stdout,
      stderr: collectStdout(),
      createModels: async () => ({
        setProvider() {},
        async login(_id, _kind, interaction) {
          const hidden = await interaction.prompt({ type: "manual_code", message: "Code" });
          const note = await interaction.prompt({ message: "Note" });
          assert.equal(hidden, code);
          assert.equal(note.trim(), "hi");
        }
      })
    })
  );
  try {
    await waitForText(stdout, "Code:");
    stdin.write(`${code}\r`);
    await waitForText(stdout, "Note:");
    stdin.write("hi\n");
    await running;
  } catch (error) {
    stdin.end();
    await running.catch(() => {});
    throw error;
  }
  assert.doesNotMatch(stdout.text, new RegExp(code));
});

test("question EOF rejects promptly instead of waiting for login timeout", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const start = Date.now();
  const running = runAuth(
    loginOpts({
      stdin,
      stdout,
      stderr: collectStdout(),
      loginTimeoutMs: 15_000,
      createModels: async () => ({
        setProvider() {},
        async login(_id, _kind, interaction) {
          await interaction.prompt({ message: "Name" });
        }
      })
    })
  );
  try {
    await waitForText(stdout, "Name");
    stdin.end();
    await assert.rejects(running, (error) => error instanceof AuthError && error.code === "abort");
  } catch (error) {
    stdin.destroy();
    await running.catch(() => {});
    throw error;
  }
  assert.ok(Date.now() - start < 2000, "EOF must not wait for the login timeout");
});

test("select accepts only an exact integer or exact id", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const running = runAuth(
    loginOpts({
      stdin,
      stdout,
      stderr: collectStdout(),
      createModels: async () => ({
        setProvider() {},
        async login(_id, _kind, interaction) {
          return interaction.prompt({
            type: "select",
            message: "Account",
            options: [
              { id: "one", label: "One" },
              { id: "two", label: "Two" }
            ]
          });
        }
      })
    })
  );
  try {
    await waitForText(stdout, "Enter number");
    stdin.write("1junk\n");
    await assert.rejects(running, (error) => error instanceof AuthError && error.code === "auth");
  } catch (error) {
    stdin.end();
    await running.catch(() => {});
    throw error;
  }

  const stdinOk = ttyStdin();
  const stdoutOk = collectStdout();
  const selected = { id: null };
  const runningOk = runAuth(
    loginOpts({
      stdin: stdinOk,
      stdout: stdoutOk,
      stderr: collectStdout(),
      createModels: async () => ({
        setProvider() {},
        async login(_id, _kind, interaction) {
          selected.id = await interaction.prompt({
            type: "select",
            message: "Account",
            options: [
              { id: "one", label: "One" },
              { id: "two", label: "Two" }
            ]
          });
        }
      })
    })
  );
  try {
    await waitForText(stdoutOk, "Enter number");
    stdinOk.write("two\n");
    await runningOk;
  } catch (error) {
    stdinOk.end();
    await runningOk.catch(() => {});
    throw error;
  }
  assert.equal(selected.id, "two");
});

test("non-TTY login hint uses this helper path, not CLAUDE_PLUGIN_ROOT", async () => {
  const stderr = collectStdout();
  await assert.rejects(
    () =>
      runAuth(
        loginOpts({
          isTTY: false,
          stdout: collectStdout(),
          stderr,
          env: {
            CLAUDE_PLUGIN_ROOT: "/tmp/missing-plugin-root",
            CLAUDE_CONFIG_DIR: "/tmp/cma-config-dir"
          },
          createBuiltinProvider: async () => {
            throw new Error("must not start OAuth");
          },
          createModels: async () => {
            throw new Error("must not start OAuth");
          }
        })
      ),
    (error) => error instanceof AuthError && error.code === "tty"
  );
  assert.match(stderr.text, /auth-control\.mjs login codex/);
  assert.doesNotMatch(stderr.text, /missing-plugin-root/);
  assert.match(stderr.text, /CLAUDE_CONFIG_DIR=\/tmp\/cma-config-dir/);
});


test("unknown OAuth provider id is rejected without a fallback list", async () => {
  await assert.rejects(
    () =>
      runAuth(
        loginOpts({
          loadConfig: async () => oauthConfig("codex", "not-a-provider"),
          createBuiltinProvider: async () => {
            throw new Error("no fallback");
          },
          createModels: async () => {
            throw new Error("no fallback");
          }
        })
      ),
    (error) => error instanceof AuthError && error.code === "not-oauth"
  );
});

test("hidden-input EOF cancels login", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const running = runAuth(loginOpts({
    stdin,
    stdout,
    createModels: async () => ({
      setProvider() {},
      async login(_id, _kind, interaction) {
        await interaction.prompt({ type: "manual_code", message: "Callback" });
      }
    })
  }));
  await waitForText(stdout, "Callback:");
  stdin.end();
  await assert.rejects(running, (error) => error instanceof AuthError && error.code === "abort");
});

test("Ctrl-C cancels pending authorization after a text prompt has finished", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const running = runAuth(loginOpts({
    stdin,
    stdout,
    createModels: async () => ({
      setProvider() {},
      async login(_id, _kind, interaction) {
        await interaction.prompt({ message: "Account" });
        await new Promise((_resolve, reject) => {
          interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
          stdout.write("Waiting for authorization\n");
        });
      }
    })
  }));
  await waitForText(stdout, "Account:");
  stdin.write("example\n");
  await waitForText(stdout, "Waiting for authorization");
  stdin.write("\u0003");
  await assert.rejects(running, (error) => error instanceof AuthError && error.code === "abort");
});

test("declining Copilot model enablement starts no OAuth requests", async (t) => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No request is authorized");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const running = runAuth({
    argv: ["login", "copilot"],
    env: {},
    processEnv: {},
    stdin,
    stdout,
    isTTY: true,
    loadConfig: async () => oauthConfig("copilot", "github-copilot"),
    createCredentialStore: () => fakeStore()
  });
  await waitForText(stdout, "Continue? [y/N]");
  stdin.write("n\n");
  await assert.rejects(running, (error) => error instanceof AuthError && error.code === "abort");
  assert.equal(requests, 0);
});

test("browser completion releases stdin after cancelling the manual-code prompt", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  await runAuth(loginOpts({
    stdin,
    stdout,
    createModels: async () => ({
      setProvider() {},
      async login(_id, _kind, interaction) {
        const manual = new AbortController();
        const pending = interaction.prompt({
          type: "manual_code",
          message: "Browser or callback",
          signal: manual.signal
        });
        manual.abort();
        await pending.catch(() => {});
      }
    })
  }));
  assert.equal(stdin.isPaused(), true, "completed login must release terminal input");
  assert.equal(stdin.listenerCount("data"), 0, "manual input must not survive browser completion");
});

test("parseAuthArgv accepts only bare list and slotted login commands", () => {
  assert.deepEqual(parseAuthArgv(["list"]), { command: "list" });
  assert.deepEqual(parseAuthArgv(["login", "codex"]), { command: "login", slot: "codex" });
  assert.deepEqual(parseAuthArgv(["login-command", "codex"]), { command: "login-command", slot: "codex" });
  assert.deepEqual(parseAuthArgv(["logout", "codex"]), { command: "logout", slot: "codex" });
  assert.deepEqual(parseAuthArgv(["status", "codex"]), { command: "status", slot: "codex" });
  const usage = (error) => error instanceof AuthError && error.code === "usage";
  assert.throws(() => parseAuthArgv(["list", "codex"]), usage);
  assert.throws(() => parseAuthArgv([]), usage);
  assert.throws(() => parseAuthArgv(["login"]), usage);
  assert.throws(() => parseAuthArgv(["login-command"]), usage);
  assert.throws(() => parseAuthArgv(["logout"]), usage);
  assert.throws(() => parseAuthArgv(["status"]), usage);
  assert.throws(() => parseAuthArgv(["login", "Codex"]), usage);
  assert.throws(() => parseAuthArgv(["login", "codex", "extra"]), usage);
});

test("list prints configured slot metadata without secrets or authentication", async () => {
  const { code, stdout, stderr } = await runList();
  assert.equal(code, 0);
  assert.equal(stderr.text, "");
  const payload = JSON.parse(stdout.text);
  assert.deepEqual(payload, {
    slots: [
      {
        slot: "xai-api",
        provider: "xai",
        kind: "api",
        advisors: [{ name: "api-reviewer", model: "grok-3" }]
      },
      {
        slot: "xai-oauth",
        provider: "xai",
        kind: "oauth",
        advisors: [{ name: "oauth-reviewer", model: "grok-4" }]
      }
    ]
  });
  assert.doesNotMatch(stdout.text, /apiKeyEnv|XAI_API_KEY|sk-live-secret-must-not-leak|SECRET_INSTRUCTIONS|instructions|accessToken|refresh/i);
});

test("list extra arguments are usage and load no config or credentials", async () => {
  const stdout = collectStdout();
  await assert.rejects(
    () =>
      runAuth({
        argv: ["list", "codex"],
        stdout,
        loadConfig: async () => {
          throw new Error("must not load config");
        },
        ...refuseAuth()
      }),
    (error) => error instanceof AuthError && error.code === "usage"
  );
  assert.equal(stdout.text, "");
});

test("list missing config directs to setup without leaking loader errors", async () => {
  const stdout = collectStdout();
  const dir = await scratch("cma-auth-list-missing-");
  await assert.rejects(
    () =>
      runAuth({
        argv: ["list"],
        env: { CLAUDE_CONFIG_DIR: dir },
        stdout,
        ...refuseAuth()
      }),
    (error) =>
      error instanceof AuthError &&
      error.code === "setup" &&
      error.message.includes("/cross-model-advisor:setup") &&
      !error.message.includes(dir)
  );
  assert.equal(stdout.text, "");
});

test("list invalid config directs to setup without leaking validation text", async () => {
  const stdout = collectStdout();
  await assert.rejects(
    () =>
      runAuth({
        argv: ["list"],
        env: { CLAUDE_CONFIG_DIR: "/tmp/cma-auth-list-invalid" },
        stdout,
        loadConfig: async () => {
          const error = new Error(`config file is not valid JSON token=sk-leaked-${"x".repeat(8)}`);
          error.name = "ConfigError";
          throw error;
        },
        ...refuseAuth()
      }),
    (error) =>
      error instanceof AuthError &&
      error.code === "setup" &&
      error.message.includes("/cross-model-advisor:setup") &&
      !error.message.includes("sk-leaked")
  );
  assert.equal(stdout.text, "");
});

test("login-command still prints a hint without listing or authenticating", async () => {
  const stdout = collectStdout();
  const code = await runAuth({
    argv: ["login-command", "codex"],
    env: { CLAUDE_CONFIG_DIR: "/tmp/cma-config-dir" },
    stdout,
    loadConfig: async () => {
      throw new Error("must not load config");
    },
    ...refuseAuth()
  });
  assert.equal(code, 0);
  assert.match(stdout.text, /auth-control\.mjs login codex/);
  assert.match(stdout.text, /CLAUDE_CONFIG_DIR=\/tmp\/cma-config-dir/);
});
