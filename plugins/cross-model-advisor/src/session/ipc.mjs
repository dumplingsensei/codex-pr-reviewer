/**
 * Capability-gated newline JSON over a Unix socket. Control capability
 * lives in the session locator.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { WARM_IPC_MS } from "./constants.mjs";

const MAX_FRAME = 1_048_576;

export function randomCapability() {
  return crypto.randomBytes(24).toString("hex");
}

export function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export const PROTOCOL_VERSION = 2;

/**
 * Issuance identity for hook claims. Worker tracks this until stdout
 * acknowledgement or the client process is proven dead.
 */
export function createClientMeta() {
  return {
    pid: process.pid,
    id: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION
  };
}


/**
 * @param {unknown} value
 */
export function encodeFrame(value) {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Split a buffer into complete newline JSON frames plus remainder.
 * Survives chunk boundaries; incomplete trailing JSON stays in rest.
 *
 * @param {Buffer} buffer
 * @returns {{ frames: object[], rest: Buffer, errors: string[] }}
 */
export function splitFrames(buffer) {
  const frames = [];
  const errors = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nl = buffer.indexOf(0x0a, offset);
    if (nl === -1) break;
    const line = buffer.subarray(offset, nl).toString("utf8").replace(/\r$/, "");
    offset = nl + 1;
    if (line.trim() === "") continue;
    if (line.length > MAX_FRAME) {
      errors.push("frame too large");
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") frames.push(parsed);
      else errors.push("frame not an object");
    } catch {
      errors.push("invalid json");
    }
  }
  return { frames, rest: buffer.subarray(offset), errors };
}

/**
 * @param {string} socketPath
 * @param {(req: object, respond: (res: object) => void) => void | Promise<void>} handler
 * @returns {Promise<net.Server>}
 */
export function listenIpc(socketPath, handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: false }, (socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length > MAX_FRAME * 4) {
          socket.destroy();
          return;
        }
        const split = splitFrames(buf);
        buf = split.rest;
        for (const frame of split.frames) {
          const respond = (res) => {
            if (socket.destroyed) return;
            const body = encodeFrame({
              ok: res?.ok === true,
              result: res?.result,
              error: res?.error,
              id: frame.id ?? res?.id
            });
            socket.write(body);
          };
          Promise.resolve(handler(frame, respond)).catch((error) => {
            respond({ ok: false, error: error instanceof Error ? error.message : "handler failed" });
          });
        }
      });
      socket.on("error", () => socket.destroy());
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

/**
 * @param {string} socketPath
 * @param {object} request
 * @param {{ timeoutMs?: number }} [options]
 */
export async function requestIpc(socketPath, request, { timeoutMs = WARM_IPC_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("ipc timeout"));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("connect", () => {
      socket.write(encodeFrame(request));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const split = splitFrames(buf);
      buf = split.rest;
      const frame = split.frames[0];
      if (!frame) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(frame);
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (!settled) fail(new Error("ipc closed"));
    });
  });
}

/**
 * @param {string} socketPath
 */
export function socketExists(socketPath) {
  try {
    return fs.existsSync(socketPath);
  } catch {
    return false;
  }
}

/**
 * Resolve only after the stream write callback. Returning true from
 * write() is not completion; a paused writer must not be acknowledged.
 *
 * @param {NodeJS.WritableStream} stream
 * @param {string|Uint8Array} data
 */
export function writeCompleted(stream, data) {
  return new Promise((resolve, reject) => {
    if (data == null || data === "") {
      resolve();
      return;
    }
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      stream.write(data, done);
    } catch (error) {
      done(error);
    }
  });
}
