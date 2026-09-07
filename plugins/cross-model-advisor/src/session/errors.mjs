/**
 * Rate-limited sanitized local errors. Never write raw payloads or secrets.
 */

import fs from "node:fs/promises";
import { ERROR_LOG_INTERVAL_MS, ERROR_LOG_MAX_BYTES, FILE_MODE } from "./constants.mjs";
import { errorLogPath } from "./paths.mjs";
import { sanitizeText } from "./sanitize.mjs";

export function createErrorLog(sessionDirectory, { secrets = [], now = () => Date.now() } = {}) {
  let lastAt = 0;
  let lastMessage = "";
  let closed = false;
  return {
    /**
     * @param {unknown} error
     */
    async record(error) {
      if (closed) return;
      const at = now();
      const secretList = typeof secrets === "function" ? secrets() : secrets;
      const message = sanitizeText(
        error instanceof Error ? error.message : String(error ?? "error"),
        secretList
      );
      if (message === lastMessage && at - lastAt < ERROR_LOG_INTERVAL_MS) return;
      lastAt = at;
      lastMessage = message;
      const file = errorLogPath(sessionDirectory);
      const line = `${new Date(at).toISOString()} ${message.slice(0, 500)}\n`;
      try {
        await fs.appendFile(file, line, { mode: FILE_MODE });
        await fs.chmod(file, FILE_MODE).catch(() => {});
        const stat = await fs.stat(file);
        if (stat.size > ERROR_LOG_MAX_BYTES) {
          const raw = await fs.readFile(file);
          await fs.writeFile(file, raw.subarray(stat.size - ERROR_LOG_MAX_BYTES / 2), { mode: FILE_MODE });
        }
      } catch {
        // local log is best-effort
      }
    },
    close() {
      closed = true;
    }
  };
}
