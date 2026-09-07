#!/usr/bin/env node
/**
 * Terminal-owned OAuth login, logout, status, and configured-slot listing.
 * Interactive login is not a hook or control-worker path; run it in the
 * user's own terminal.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { configFilePath, loadConfig as defaultLoadConfig, OAUTH_PROVIDERS } from "./config.mjs";
import { AuthError, createCredentialStore as defaultCreateStore } from "./auth.mjs";

const COMMANDS = new Set(["list", "login", "login-command", "logout", "status"]);
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const USAGE = "usage: auth-control.mjs list | login|login-command|logout|status <configured-slot>";
const HIDDEN_PROMPT_TYPES = new Set(["secret", "manual_code"]);
const OAUTH_OVERRIDE_ENV = Object.freeze([
  "PI_OAUTH_CALLBACK_HOST",
  "KIMI_CODE_OAUTH_HOST",
  "KIMI_OAUTH_HOST"
]);
const COPILOT_DISCLOSURE =
  "GitHub Copilot login will POST /models/<id>/policy {state:\"enabled\"} for unconfigured personal models on this account. Organization and account restrictions still apply and are not bypassed.\n";

const SEALED_AUTH = Object.freeze({
  env: async () => undefined,
  fileExists: async () => false
});

const STATIC_ERRORS = Object.freeze({
  usage: USAGE,
  tty: "Login must be run in your own terminal.",
  "not-oauth": "Configured slot is not a supported OAuth provider.",
  "unknown-slot": "Unknown configured slot.",
  override: "OAuth endpoint overrides are not allowed.",
  timeout: "Login timed out.",
  abort: "Login cancelled.",
  "secret-unsupported": "Secret prompts require a hidden-input terminal.",
  symlink: "Credential storage is invalid.",
  storage: "Credential storage is unavailable.",
  busy: "Credential storage is busy. Retry after the current login, logout, or refresh finishes.",
  "stale-lock":
    "Credential lock is stale. Remove it only after verifying no login, logout, or refresh is running.",
  provider: "OAuth credentials do not match this provider.",
  identifier: "Invalid configured slot.",
  setup: "Missing or invalid configuration. Run /cross-model-advisor:setup.",
  auth: "authentication failed"
});

/**
 * @param {string} value
 */
function resolvedPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * @param {unknown} value
 */
function posixQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string[]} argv
 */
export function parseAuthArgv(argv) {
  const command = argv[0];
  if (command === "list") {
    if (argv.length !== 1) {
      throw new AuthError("usage", USAGE);
    }
    return { command };
  }
  const slot = argv[1];
  if (!COMMANDS.has(command) || typeof slot !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(slot) || argv.length !== 2) {
    throw new AuthError("usage", USAGE);
  }
  return { command, slot };
}

async function defaultCreateBuiltinProvider(id) {
  const { createBuiltinProvider } = await import("./providers.mjs");
  return createBuiltinProvider(id);
}

async function defaultCreateModels(options) {
  const { createModels } = await import("@earendil-works/pi-ai");
  return createModels(options);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.ProcessEnv} [processEnv]
 */
function oauthOverrideName(env, processEnv = process.env) {
  for (const name of OAUTH_OVERRIDE_ENV) {
    if (nonempty(env[name]) || nonempty(processEnv[name])) return name;
  }
  return null;
}

/**
 * @param {unknown} value
 */
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {unknown} value
 */
function isYes(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "y" || text === "yes";
}

/**
 * @param {unknown} error
 */
function publicErrorCode(error) {
  if (error && error.code === "ABORT_ERR") return "abort";
  if (error && (error.name === "AbortError" || error.code === "abort")) {
    if (error.name === "TimeoutError") return "timeout";
    return "abort";
  }
  if (error && error.name === "TimeoutError") return "timeout";
  if (error instanceof AuthError && Object.hasOwn(STATIC_ERRORS, error.code)) {
    return error.code;
  }
  return "auth";
}

/**
 * @param {NodeJS.WritableStream} stderr
 * @param {unknown} error
 */
function writeFailure(stderr, error) {
  const code = publicErrorCode(error);
  stderr.write(`${STATIC_ERRORS[code] || STATIC_ERRORS.auth}\n`);
}

/**
 * @param {string} slot
 * @param {NodeJS.ProcessEnv} env
 */
function loginHint(slot, env) {
  const exe = posixQuote(resolvedPath(fileURLToPath(import.meta.url)));
  const command = `node ${exe} login ${posixQuote(slot)}`;
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  return `CLAUDE_CONFIG_DIR=${posixQuote(configDir)} ${command}`;
}

/**
 * @param {import("node:readline").Interface} rl
 * @param {string} query
 * @param {AbortSignal[]} signals
 */
function question(rl, query, signals) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (deliver, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      deliver(value);
    };
    const abort = () => finish(reject, abortReason(signals));
    const onClose = () => finish(reject, new AuthError("abort", "aborted"));
    const cleanup = () => {
      rl.removeListener("close", onClose);
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    };
    for (const signal of signals) {
      if (signal.aborted) {
        finish(reject, abortReason(signals));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    rl.once("close", onClose);
    rl.question(query, (answer) => finish(resolve, answer));
  });
}

/**
 * @param {AbortSignal[]} signals
 */
function abortReason(signals) {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted?.reason instanceof Error) return aborted.reason;
  const error = new AuthError("abort", "aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @param {NodeJS.ReadStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {string} message
 * @param {AbortSignal[]} signals
 */
function readSecretLine(stdin, stdout, message, signals) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new AuthError("secret-unsupported", "Secret prompts require a hidden-input terminal."));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let raw = false;
    const previousRaw = Boolean(stdin.isRaw);
    const onEnd = () => finish(new AuthError("abort", "aborted"), true);
    const abort = () => finish(abortReason(signals), true);
    const finish = (value, isError) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write("\n");
      if (isError) reject(value);
      else resolve(value);
    };
    const cleanup = () => {
      if (raw && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(previousRaw);
        } catch {
          // already restored or not a TTY anymore
        }
        raw = false;
      }
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.pause();
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    };
    const onData = (input) => {
      const text = input.toString("utf8");
      for (const char of text) {
        if (char === "\u0003" || char === "\u0004") {
          finish(new AuthError("abort", "aborted"), true);
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(chunks.join(""), false);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          chunks.pop();
          continue;
        }
        if (char === "\u0015") {
          chunks.length = 0;
          continue;
        }
        if (char.charCodeAt(0) < 32) continue;
        chunks.push(char);
      }
    };
    for (const signal of signals) {
      if (signal.aborted) {
        finish(abortReason(signals), true);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    stdout.write(`${message}: `);
    stdin.setRawMode(true);
    raw = true;
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.once("error", onEnd);
  });
}

/** Open only browser-authorization URLs, never shell commands or device-mode links. */
function openAuthorizationUrl(value, stdout) {
  const fallback = () => stdout.write("Could not open the browser automatically. Open the URL above manually.\n");
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== "https:") return fallback();
  } catch {
    return fallback();
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url.href], { stdio: "ignore", detached: true });
    child.once("error", fallback);
    child.once("exit", (code) => { if (code !== 0) fallback(); });
    child.unref();
  } catch {
    fallback();
  }
}

/**
 * @param {NodeJS.WritableStream} stdout
 * @param {object} event
 */
function notify(stdout, event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "auth_url") {
    stdout.write("Open this URL in your browser:\n");
    if (typeof event.url === "string") {
      stdout.write(`${event.url}\n`);
      openAuthorizationUrl(event.url, stdout);
    }
    if (typeof event.instructions === "string") stdout.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "device_code") {
    if (typeof event.verificationUri === "string") {
      stdout.write("Open this URL in your browser:\n");
      stdout.write(`${event.verificationUri}\n`);
    }
    if (typeof event.userCode === "string") {
      stdout.write(`Enter code: ${event.userCode}\n`);
    }
    return;
  }
  if (event.type === "progress" || event.type === "info") {
    if (typeof event.message === "string") stdout.write(`${event.message}\n`);
    if (Array.isArray(event.links)) {
      for (const link of event.links) {
        if (link && typeof link.url === "string") {
          const label = typeof link.label === "string" ? `${link.label}: ` : "";
          stdout.write(`${label}${link.url}\n`);
        }
      }
    }
  }
}

/**
 * @param {string} raw
 * @param {number} count
 */
function selectIndex(raw, count) {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 1 || index > count) return null;
  return index;
}

/**
 * @param {{
 *   stdin: NodeJS.ReadStream,
 *   stdout: NodeJS.WritableStream,
 *   signal: AbortSignal,
 *   isTTY: boolean,
 *   onCancel: () => void
 * }} io
 */
function createInteraction(io) {
  const { stdin, stdout, signal, isTTY, onCancel } = io;
  const initialRaw = Boolean(stdin.isRaw);
  if (!isTTY) {
    throw new AuthError("tty", "Login must be run in your own terminal.");
  }
  let rl = null;

  const openReadline = () => {
    if (!rl) {
      const current = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      rl = current;
      current.on("SIGINT", onCancel);
      current.on("close", () => {
        if (rl === current) {
          rl = null;
          onCancel();
        }
      });
    }
    return rl;
  };

  const closeReadline = () => {
    if (!rl) return;
    const current = rl;
    rl = null;
    current.close();
  };

  const close = () => {
    closeReadline();
    stdin.pause();
    if (typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(initialRaw);
      } catch {
        // ignore
      }
    }
  };

  return {
    close,
    interaction: {
      signal,
      /**
       * @param {object} prompt
       */
      async prompt(prompt) {
        const signals = [signal];
        if (prompt?.signal) signals.push(prompt.signal);
        const message = typeof prompt?.message === "string" ? prompt.message : "Input";
        if (HIDDEN_PROMPT_TYPES.has(prompt?.type)) {
          closeReadline();
          return readSecretLine(stdin, stdout, message, signals);
        }
        const current = openReadline();
        if (prompt?.type === "select") {
          const options = Array.isArray(prompt.options) ? prompt.options : [];
          stdout.write(`${message}\n`);
          for (const [index, option] of options.entries()) {
            const label = typeof option?.label === "string" ? option.label : String(option?.id ?? "");
            const extra = typeof option?.description === "string" ? ` — ${option.description}` : "";
            stdout.write(`  ${index + 1}. ${label}${extra}\n`);
          }
          const raw = (await question(current, `Enter number (1-${options.length}): `, signals)).trim();
          const byIndex = selectIndex(raw, options.length);
          if (byIndex !== null) return options[byIndex - 1].id;
          const byId = options.find((option) => option?.id === raw);
          if (byId) return byId.id;
          throw new AuthError("auth", "authentication failed");
        }
        const placeholder = typeof prompt?.placeholder === "string" ? ` (${prompt.placeholder})` : "";
        return question(current, `${message}${placeholder}: `, signals);
      },
      notify(event) {
        notify(stdout, event);
      }
    }
  };
}

/**
 * @param {object} config
 * @param {string} slot
 */
function resolveOAuthSlot(config, slot) {
  const entry = config?.providers?.[slot];
  if (!entry) {
    throw new AuthError("unknown-slot", "Unknown configured slot.");
  }
  if (entry.kind !== "oauth" || typeof entry.provider !== "string" || !OAUTH_PROVIDERS.includes(entry.provider)) {
    throw new AuthError("not-oauth", "Configured slot is not a supported OAuth provider.");
  }
  return entry;
}

/**
 * Configured slot metadata for the login picker. Copies only slot ids,
 * upstream provider ids, auth kind, and associated advisor names/models.
 * @param {object} config
 */
function configuredSlotList(config) {
  // loadConfig has already validated the complete configuration.
  const slots = [];
  for (const slot of Object.keys(config.providers)) {
    const entry = config.providers[slot];
    /** @type {{ name: string, model: string }[]} */
    const associated = [];
    for (const advisor of config.advisors) {
      if (advisor.provider === slot) {
        associated.push({ name: advisor.name, model: advisor.model });
      }
    }
    slots.push({
      slot,
      provider: entry.provider,
      kind: entry.kind,
      advisors: associated
    });
  }
  return { slots };
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   loadConfig?: typeof defaultLoadConfig,
 *   createBuiltinProvider?: (id: string) => Promise<object> | object,
 *   createCredentialStore?: typeof defaultCreateStore,
 *   createModels?: (options: object) => object | Promise<object>,
 *   isTTY?: boolean,
 *   loginTimeoutMs?: number,
 *   processEnv?: NodeJS.ProcessEnv,
 *   confirmCopilot?: () => Promise<boolean> | boolean
 * }} [options]
 */
export async function runAuth(options = {}) {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? [];
  const parsed = parseAuthArgv(argv);
  // This skill-safe command reads no configuration or credentials and cannot
  // initialize an OAuth flow. It pins the actual helper and configuration paths.
  if (parsed.command === "login-command") {
    stdout.write(`${loginHint(parsed.slot, env)}\n`);
    return 0;
  }
  if (parsed.command === "list") {
    const loadConfigFn = options.loadConfig ?? defaultLoadConfig;
    let config;
    try {
      config = await loadConfigFn({ env });
    } catch {
      throw new AuthError("setup", STATIC_ERRORS.setup);
    }
    stdout.write(`${JSON.stringify(configuredSlotList(config))}\n`);
    return 0;
  }
  const { command, slot } = parsed;
  const loadConfigFn = options.loadConfig ?? defaultLoadConfig;
  const createStoreFn = options.createCredentialStore ?? defaultCreateStore;
  const config = await loadConfigFn({ env });
  const entry = resolveOAuthSlot(config, slot);
  const store = createStoreFn({ env, slot, provider: entry.provider });

  if (command === "status") {
    const listed = await store.list();
    const loggedIn = listed.some((item) => item.providerId === entry.provider && item.type === "oauth");
    stdout.write(`slot: ${slot}\n`);
    stdout.write(`provider: ${entry.provider}\n`);
    stdout.write(`status: ${loggedIn ? "logged-in" : "logged-out"}\n`);
    if (loggedIn) stdout.write("type: oauth\n");
    return 0;
  }

  if (command === "logout") {
    await store.delete(entry.provider);
    stdout.write(`Logged out slot ${slot}.\n`);
    return 0;
  }

  const override = oauthOverrideName(env, options.processEnv ?? process.env);
  if (override) {
    throw new AuthError("override", "OAuth endpoint overrides are not allowed.");
  }

  const tty = options.isTTY ?? Boolean(stdin.isTTY && stdout.isTTY);
  if (!tty) {
    stderr.write(`${loginHint(slot, env)}\n`);
    throw new AuthError("tty", STATIC_ERRORS.tty);
  }

  const createProviderFn = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  const createModelsFn = options.createModels ?? defaultCreateModels;
  const builtin = await createProviderFn(entry.provider);
  if (!builtin || builtin.id !== entry.provider || !builtin.auth?.oauth) {
    throw new AuthError("not-oauth", "Configured slot is not a supported OAuth provider.");
  }

  const timeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(Object.assign(new Error("login timed out"), { name: "TimeoutError" })), timeoutMs);
  const onSignal = () => ac.abort(new AuthError("abort", "aborted"));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  /** @type {{ close: () => void, interaction: object } | undefined} */
  let terminal;
  try {
    if (entry.provider === "github-copilot") {
      stdout.write(COPILOT_DISCLOSURE);
      if (options.confirmCopilot !== undefined) {
        const accepted = await options.confirmCopilot();
        if (!accepted) {
          throw new AuthError("abort", "Login cancelled.");
        }
      }
    }
    terminal = createInteraction({ stdin, stdout, signal: ac.signal, isTTY: true, onCancel: onSignal });
    if (entry.provider === "github-copilot" && options.confirmCopilot === undefined) {
      if (!isYes(await terminal.interaction.prompt({ message: "Continue? [y/N]" }))) {
        throw new AuthError("abort", "Login cancelled.");
      }
    }
    const models = await createModelsFn({ credentials: store, authContext: SEALED_AUTH });
    models.setProvider(builtin);
    await models.login(builtin.id, "oauth", terminal.interaction);
    stdout.write(`Logged in slot ${slot} (${entry.provider}).\n`);
    return 0;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    terminal?.close();
  }
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    await runAuth({ argv, env });
  } catch (error) {
    writeFailure(process.stderr, error);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && resolvedPath(process.argv[1]) === resolvedPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
