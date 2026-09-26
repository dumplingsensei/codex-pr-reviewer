#!/usr/bin/env node
/**
 * Offline setup helper CLI. Dispatches catalog/models/save through the shared
 * store, prints a safe menu launcher, and opens the terminal menu. No login,
 * no network, no credential reads, and no session activation from catalog
 * or save.
 */

import { fileURLToPath } from "node:url";
import { SetupError, main as storeMain } from "./setup-store.mjs";
import { runSetupMenu } from "./setup-menu.mjs";
import { sanitizeText } from "./session/sanitize.mjs";
import { formatMenuCommand, resolvedPath } from "./terminal-command.mjs";

const USAGE =
  "usage: setup-control.mjs catalog|summary|providers|models <provider-id>|efforts <provider-id> <api|oauth> <model>|save|apply [--dry-run]|menu|menu-command";
const MAX_ERROR_CHARS = 500;

/**
 * @param {NodeJS.WritableStream} stderr
 * @param {unknown} error
 */
function writeFailure(stderr, error) {
  if (error instanceof SetupError) {
    const message = sanitizeText(error.message).slice(0, MAX_ERROR_CHARS);
    stderr.write(`${message || USAGE}\n`);
    return;
  }
  stderr.write(`${USAGE}\n`);
}

/**
 * @param {unknown} error
 */
function isAbortError(error) {
  return Boolean(error && (error.code === "abort" || error.name === "AbortError" || error.code === "ABORT_ERR"));
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0];
  const helperPath = resolvedPath(fileURLToPath(import.meta.url));

  if (command === "menu-command") {
    try {
      if (argv.length !== 1) throw new SetupError("usage", USAGE);
      process.stdout.write(`${formatMenuCommand({ env, helperPath })}\n`);
    } catch (error) {
      writeFailure(process.stderr, error);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "menu") {
    try {
      if (argv.length !== 1) throw new SetupError("usage", USAGE);
      const code = await runSetupMenu({
        env,
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        helperPath
      });
      if (typeof code === "number" && code !== 0) process.exitCode = code;
    } catch (error) {
      if (isAbortError(error)) return;
      writeFailure(process.stderr, error);
      process.exitCode = 1;
    }
    return;
  }

  if (["catalog", "summary", "providers", "models", "efforts", "save", "apply"].includes(command)) {
    await storeMain(argv, env);
    return;
  }

  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && resolvedPath(process.argv[1]) === resolvedPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
