/**
 * Raw-terminal primitives for the setup menu. No config, session, or
 * inference. Display sanitization never mutates stored editor text.
 */

import { stripVTControlCharacters } from "node:util";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const SEQ_ENTER = `${CSI}?1049h${CSI}?25l${CSI}?2004h`;
const SEQ_LEAVE = `${CSI}?2004l${CSI}?25h${CSI}0m${CSI}?1049l`;
const SEQ_HOME_CLEAR = `${CSI}H${CSI}J`;
const ESC_WAIT_MS = 35;
const MAX_LOAD_LIMIT = 40;
const MAX_QUERY_CHARS = 128;
const DEFAULT_MAX_BYTES = 8192;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const PASTE_END = `${CSI}201~`;
const PASTE_TAIL = 6;

const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export class TerminalError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
  }
}

/**
 * @param {unknown} reason
 */
function abortError(reason) {
  if (reason instanceof TerminalError && reason.code === "abort") {
    reason.name = "AbortError";
    return reason;
  }
  const error = new TerminalError("abort", "aborted");
  error.name = "AbortError";
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function ttyError() {
  return new TerminalError("tty", "Setup menu requires a real terminal.");
}

/**
 * @param {unknown} stdin
 * @param {unknown} stdout
 */
function assertTty(stdin, stdout) {
  if (
    !stdin ||
    stdin.isTTY !== true ||
    typeof stdin.setRawMode !== "function" ||
    !stdout ||
    stdout.isTTY !== true ||
    typeof stdout.write !== "function"
  ) {
    throw ttyError();
  }
}

/**
 * @param {string} text
 */
function graphemes(text) {
  const out = [];
  for (const { segment } of SEGMENTER.segment(String(text ?? ""))) out.push(segment);
  return out;
}

/**
 * @param {number} cp
 */
function isZeroWidthCp(cp) {
  if (cp <= 0x1f || cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  if (cp >= 0x300 && cp <= 0x36f) return true;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  return (
    cp === 0x00ad ||
    cp === 0x180e ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/**
 * @param {number} cp
 */
function isWideCp(cp) {
  if (cp >= 0x1100 && cp <= 0x115f) return true;
  if (cp === 0x2329 || cp === 0x232a) return true;
  if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) return true;
  if (cp >= 0xac00 && cp <= 0xd7a3) return true;
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  if (cp >= 0xfe10 && cp <= 0xfe19) return true;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true;
  if (cp >= 0xff00 && cp <= 0xff60) return true;
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  if (cp >= 0x1aff0 && cp <= 0x1b122) return true;
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  if (cp >= 0x20000 && cp <= 0x3fffd) return true;
  return false;
}

/**
 * @param {string} grapheme
 */
function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  let width = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isZeroWidthCp(cp)) continue;
    width += isWideCp(cp) ? 2 : 1;
  }
  return width > 2 ? 2 : width;
}

/**
 * @param {string} text
 */
function displayWidth(text) {
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}

/**
 * @param {string} text
 * @param {number} columns
 */
function clip(text, columns) {
  if (columns <= 0) return "";
  let out = "";
  let width = 0;
  for (const g of graphemes(text)) {
    const next = graphemeWidth(g);
    if (width + next > columns) break;
    out += g;
    width += next;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} columns
 */
function padTo(text, columns) {
  const width = displayWidth(text);
  if (width >= columns) return text;
  return text + " ".repeat(columns - width);
}

/**
 * @param {unknown} value
 */
function sanitizeDisplay(value) {
  const text = stripVTControlCharacters(String(value ?? ""));
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, "");
}

/**
 * @param {unknown} value
 */
function sanitizeLine(value) {
  return sanitizeDisplay(value).replace(/[\n\r\t]+/g, " ");
}

/**
 * @param {string} text
 * @param {number} columns
 */
function wrapLines(text, columns) {
  const lines = [];
  const width = Math.max(1, columns);
  for (const para of sanitizeDisplay(text).split("\n")) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const g of graphemes(para)) {
      const w = graphemeWidth(g);
      if (w <= 0) continue;
      if (used + w > width && line) {
        lines.push(line);
        line = "";
        used = 0;
      }
      if (w > width) continue;
      line += g;
      used += w;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * @param {unknown} item
 * @returns {{ value: string, label: string, description: string } | null}
 */
function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.value !== "string" || typeof item.label !== "string") return null;
  return {
    value: item.value,
    label: item.label,
    description: typeof item.description === "string" ? item.description : ""
  };
}

/**
 * @param {{ value: string, label: string, description: string }} item
 * @param {string} query
 */
function itemMatches(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    item.value.toLowerCase().includes(needle) ||
    item.label.toLowerCase().includes(needle) ||
    item.description.toLowerCase().includes(needle)
  );
}

/**
 * @param {string} text
 * @param {{ allowNewline?: boolean }} [options]
 */
function insertableText(text, { allowNewline = false } = {}) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  for (const g of graphemes(normalized)) {
    if (g === "\n") {
      out += allowNewline ? "\n" : " ";
      continue;
    }
    if (g === "\t") {
      out += " ";
      continue;
    }
    if (graphemeWidth(g) <= 0) continue;
    out += g;
  }
  return out;
}

/**
 * @param {string} body
 * @param {string} finalByte
 */
function csiEvent(body, finalByte) {
  if (finalByte === "A") return { type: "key", name: "up" };
  if (finalByte === "B") return { type: "key", name: "down" };
  if (finalByte === "C") return { type: "key", name: "right" };
  if (finalByte === "D") return { type: "key", name: "left" };
  if (finalByte === "H") return { type: "key", name: "home" };
  if (finalByte === "F") return { type: "key", name: "end" };
  if (finalByte === "~") {
    const code = body.split(";")[0];
    if (code === "3") return { type: "key", name: "delete" };
    if (code === "5") return { type: "key", name: "pageup" };
    if (code === "6") return { type: "key", name: "pagedown" };
    if (code === "1" || code === "7") return { type: "key", name: "home" };
    if (code === "4" || code === "8") return { type: "key", name: "end" };
    if (code === "200") return { type: "pasteStart" };
    if (code === "201") return { type: "pasteEnd" };
  }
  return { type: "key", name: "unknown" };
}

/**
 * @param {string} buf
 * @returns {{ incomplete: true } | { length: number, event: { type: string, name?: string } }}
 */
function readEscape(buf) {
  if (buf.length === 0 || buf[0] !== ESC) return { length: 0, event: { type: "key", name: "unknown" } };
  if (buf.length === 1) return { incomplete: true };

  if (buf[1] === "[") {
    let i = 2;
    while (i < buf.length) {
      const code = buf.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        return { length: i + 1, event: csiEvent(buf.slice(2, i), buf[i]) };
      }
      if (code < 0x20 || code > 0x3f) {
        return { length: 1, event: { type: "key", name: "escape" } };
      }
      i += 1;
    }
    return { incomplete: true };
  }

  if (buf[1] === "O") {
    if (buf.length < 3) return { incomplete: true };
    const names = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
    return { length: 3, event: { type: "key", name: names[buf[2]] ?? "unknown" } };
  }

  return { length: 1, event: { type: "key", name: "escape" } };
}

/**
 * @param {(event: { type: string, name?: string, value?: string, paste?: boolean }) => void} emit
 */
function createParser(emit) {
  let buf = "";
  let paste = false;
  let timer = null;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function armEscTimer() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!buf.startsWith(ESC)) return;
      buf = buf.slice(1);
      emit({ type: "key", name: "escape" });
      parse();
    }, ESC_WAIT_MS);
  }

  function emitPaste(text) {
    if (text) emit({ type: "text", value: text, paste: true });
  }

  function parsePaste() {
    const idx = buf.indexOf(PASTE_END);
    if (idx === -1) {
      if (buf.length > PASTE_TAIL) {
        emitPaste(buf.slice(0, -PASTE_TAIL));
        buf = buf.slice(-PASTE_TAIL);
      }
      return false;
    }
    emitPaste(buf.slice(0, idx));
    buf = buf.slice(idx + PASTE_END.length);
    paste = false;
    return true;
  }

  function parse() {
    while (buf.length > 0) {
      if (paste) {
        if (!parsePaste()) return;
        continue;
      }

      if (buf[0] === ESC) {
        const matched = readEscape(buf);
        if ("incomplete" in matched && matched.incomplete) {
          armEscTimer();
          return;
        }
        clearTimer();
        buf = buf.slice(matched.length);
        if (matched.event.type === "pasteStart") {
          paste = true;
          continue;
        }
        if (matched.event.type === "pasteEnd") continue;
        if (matched.event.name !== "unknown") emit(matched.event);
        continue;
      }

      clearTimer();
      const cp = buf.codePointAt(0);
      const len = cp > 0xffff ? 2 : 1;
      const ch = buf.slice(0, len);
      buf = buf.slice(len);

      if (ch === "\r") {
        if (buf.startsWith("\n")) buf = buf.slice(1);
        emit({ type: "key", name: "enter" });
        continue;
      }
      if (ch === "\n") {
        emit({ type: "key", name: "enter" });
        continue;
      }
      if (ch === "\u0003") {
        emit({ type: "key", name: "interrupt" });
        continue;
      }
      if (ch === "\u0004") {
        emit({ type: "key", name: "eof" });
        continue;
      }
      if (ch === "\u0013") {
        emit({ type: "key", name: "save" });
        continue;
      }
      if (ch === "\u0015") {
        emit({ type: "key", name: "clear" });
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        emit({ type: "key", name: "backspace" });
        continue;
      }
      if (ch === "\t") {
        emit({ type: "key", name: "tab" });
        continue;
      }
      if (cp !== undefined && cp < 32) continue;

      let run = ch;
      while (buf.length > 0) {
        const nextCp = buf.codePointAt(0);
        if (nextCp === 0x1b || nextCp < 32 || nextCp === 0x7f) break;
        const nextLen = nextCp > 0xffff ? 2 : 1;
        run += buf.slice(0, nextLen);
        buf = buf.slice(nextLen);
      }
      emit({ type: "text", value: run, paste: false });
    }
  }

  return {
    /**
     * @param {Buffer | Uint8Array | string} data
     */
    push(data) {
      const text =
        typeof data === "string"
          ? data
          : decoder.decode(data, { stream: true });
      if (!text) return;
      buf += text;
      parse();
    },
    destroy() {
      clearTimer();
      buf = "";
      paste = false;
    }
  };
}

/**
 * @param {NodeJS.WritableStream} stdout
 */
function measure(stdout) {
  const columns = Number(stdout.columns);
  const rows = Number(stdout.rows);
  return {
    columns: Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_COLUMNS,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_ROWS
  };
}

/**
 * @param {string} body
 * @param {boolean} highlight
 * @param {number} columns
 */
function formatRow(body, highlight, columns) {
  const clipped = clip(body, columns);
  const padded = padTo(clipped, columns);
  return highlight ? `${CSI}7m${padded}${CSI}0m` : padded;
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 *   signal?: AbortSignal
 * }} [options]
 * @returns {{
 *   choose: Function,
 *   text: Function,
 *   confirm: Function,
 *   notice: Function,
 *   suspend: (fn: () => Promise<unknown>) => Promise<unknown>,
 *   close: () => void,
 *   readonly signal: AbortSignal
 * }}
 */
export function createTerminalUI({
  stdin = process.stdin,
  stdout = process.stdout,
  signal: inputSignal
} = {}) {
  assertTty(stdin, stdout);
  if (inputSignal?.aborted) throw abortError(inputSignal.reason);

  const previousRaw = Boolean(stdin.isRaw);
  const previousFlowing = stdin.readableFlowing === true;
  const lifecycle = new AbortController();
  let closed = false;
  let aborted = false;
  let inputListening = false;
  let lifecycleListening = false;
  let rawHeld = false;
  let screenHeld = false;
  /** @type {null | { paint: () => void, handle: (event: object) => void, fail: (error: Error) => void }} */
  let active = null;

  const parser = createParser(dispatch);

  function writeOut(chunk) {
    try {
      stdout.write(chunk);
    } catch (error) {
      if (!closed) shutdown(error);
    }
  }

  function holdRaw() {
    if (rawHeld) return;
    try {
      stdin.setRawMode(true);
    } catch {
      throw ttyError();
    }
    rawHeld = true;
    if (typeof stdin.resume === "function") stdin.resume();
  }

  function releaseRaw() {
    if (!rawHeld) return;
    try {
      stdin.setRawMode(previousRaw);
    } catch {
      // already restored or no longer a TTY
    }
    rawHeld = false;
  }

  function holdScreen() {
    if (screenHeld) return;
    stdout.write(SEQ_ENTER);
    screenHeld = true;
  }

  function releaseScreen() {
    if (!screenHeld) return;
    try {
      stdout.write(SEQ_LEAVE);
    } catch {
      // best-effort restore
    }
    screenHeld = false;
  }

  function attachInputListeners() {
    if (inputListening) return;
    inputListening = true;
    stdin.on("data", onData);
    if (typeof stdout.on === "function") stdout.on("resize", onResize);
  }

  function detachInputListeners() {
    if (!inputListening) return;
    inputListening = false;
    stdin.removeListener("data", onData);
    if (typeof stdout.removeListener === "function") stdout.removeListener("resize", onResize);
  }

  function attachLifecycleListeners() {
    if (lifecycleListening) return;
    lifecycleListening = true;
    stdin.on("end", onEnd);
    stdin.on("error", onStdinError);
    process.on("SIGINT", onProcessAbort);
    process.on("SIGTERM", onProcessAbort);
    if (inputSignal) inputSignal.addEventListener("abort", onSignalAbort);
  }

  function detachLifecycleListeners() {
    if (!lifecycleListening) return;
    lifecycleListening = false;
    stdin.removeListener("end", onEnd);
    stdin.removeListener("error", onStdinError);
    process.removeListener("SIGINT", onProcessAbort);
    process.removeListener("SIGTERM", onProcessAbort);
    if (inputSignal) inputSignal.removeEventListener("abort", onSignalAbort);
  }

  function restoreTerminal() {
    detachInputListeners();
    detachLifecycleListeners();
    parser.destroy();
    releaseScreen();
    releaseRaw();
    if (!previousFlowing && typeof stdin.pause === "function") stdin.pause();
  }

  function acquireTerminal() {
    holdRaw();
    holdScreen();
    attachInputListeners();
    attachLifecycleListeners();
  }

  /**
   * @param {unknown} reason
   */
  function shutdown(reason) {
    const error = abortError(reason);
    if (closed && aborted) {
      restoreTerminal();
      return;
    }
    aborted = true;
    closed = true;
    if (!lifecycle.signal.aborted) lifecycle.abort(error);
    const session = active;
    active = null;
    restoreTerminal();
    session?.fail(error);
  }

  function onData(data) {
    if (closed || aborted) return;
    parser.push(data);
  }

  function onEnd() {
    shutdown(abortError());
  }

  function onStdinError(error) {
    shutdown(error);
  }

  function onResize() {
    dispatch({ type: "resize" });
  }

  function onProcessAbort() {
    shutdown(abortError());
  }

  function onSignalAbort() {
    shutdown(inputSignal?.reason);
  }

  /**
   * @param {{ type: string, name?: string, value?: string, paste?: boolean }} event
   */
  function dispatch(event) {
    if (closed || aborted) return;
    if (event.type === "key" && (event.name === "interrupt" || event.name === "eof")) {
      shutdown(abortError());
      return;
    }
    if (!active) return;
    try {
      active.handle(event);
    } catch (error) {
      shutdown(error);
    }
  }

  function throwIfClosed() {
    if (aborted || closed) throw abortError();
  }

  /**
   * @param {(session: { paint: () => void, handle: (event: object) => void, finish: (value: unknown) => void, fail: (error: Error) => void }) => void} factory
   */
  function withPrompt(factory) {
    throwIfClosed();
    if (active) {
      return Promise.reject(new TerminalError("busy", "Terminal prompt is already active."));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const session = {
        paint() {},
        handle() {},
        finish(value) {
          if (settled) return;
          settled = true;
          if (active === session) active = null;
          resolve(value);
        },
        fail(error) {
          if (settled) return;
          settled = true;
          if (active === session) active = null;
          reject(error);
        }
      };
      active = session;
      try {
        factory(session);
        session.paint();
      } catch (error) {
        shutdown(error);
      }
    });
  }

  /**
   * @param {string[]} lines
   */
  function paintLines(lines) {
    const { columns, rows } = measure(stdout);
    const visible = [];
    for (const line of lines) {
      if (visible.length >= rows) break;
      visible.push(line);
    }
    writeOut(`${SEQ_HOME_CLEAR}${visible.join("\r\n")}`);
  }

  /**
   * @param {{
   *   title?: string,
   *   items?: Array<{ value: string, label: string, description?: string }>,
   *   initial?: string,
   *   search?: boolean,
   *   multiple?: boolean,
   *   selected?: string[],
   *   toggle?: boolean,
   *   footer?: string,
   *   load?: (args: { query: string, offset: number, limit: number }) => Promise<{ items?: unknown[], total?: number }>
   * }} options
   */
  function choose(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const titleLines = title.split(/\r?\n/).map(sanitizeLine);
    const staticItems = Array.isArray(options.items)
      ? options.items.map(normalizeItem).filter(Boolean)
      : [];
    const searchable = Boolean(options.search) || typeof options.load === "function";
    const multiple = options.multiple === true;
    const toggle = options.toggle === true;
    const footer = typeof options.footer === "string" ? options.footer : "";
    const loadFn = typeof options.load === "function" ? options.load : null;
    const selected = new Set(
      Array.isArray(options.selected) ? options.selected.filter((value) => typeof value === "string") : []
    );

    return withPrompt((session) => {
      let query = "";
      let offset = 0;
      let total = loadFn ? 0 : staticItems.length;
      let rows = loadFn ? [] : staticItems;
      let cursor = 0;
      let loading = Boolean(loadFn);
      let loadError = "";
      let loadGen = 0;
      let lastLimit = 0;
      let pendingCursor = options.initial;

      function pageLimit() {
        const { rows: height } = measure(stdout);
        const titleHeight = Math.min(titleLines.length, Math.max(1, height - 4));
        const chrome = (searchable ? 6 : 5) + titleHeight - 1;
        return Math.min(MAX_LOAD_LIMIT, Math.max(1, height - chrome));
      }

      function currentRows() {
        return loadFn ? rows : staticItems.filter((item) => itemMatches(item, query));
      }

      function clampCursor() {
        const list = currentRows();
        if (list.length === 0) {
          cursor = 0;
          return;
        }
        if (cursor >= list.length) cursor = list.length - 1;
        if (cursor < 0) cursor = 0;
      }

      function placeCursor(list) {
        if (typeof pendingCursor === "string" && pendingCursor) {
          const idx = list.findIndex((item) => item.value === pendingCursor);
          if (idx >= 0) cursor = idx;
          pendingCursor = null;
        }
        clampCursor();
      }

      function resetSearch() {
        offset = 0;
        cursor = 0;
        pendingCursor = null;
      }

      async function reload() {
        if (!loadFn) return;
        const gen = ++loadGen;
        const limit = pageLimit();
        lastLimit = limit;
        loading = true;
        loadError = "";
        if (active === session) session.paint();
        try {
          const result = await loadFn({ query, offset, limit });
          if (gen !== loadGen || active !== session) return;
          const items = Array.isArray(result?.items)
            ? result.items.map(normalizeItem).filter(Boolean)
            : [];
          rows = items;
          const reported = Number(result?.total);
          total = Number.isFinite(reported) && reported >= 0 ? Math.floor(reported) : items.length;
          if (offset > 0 && items.length === 0 && total > 0) {
            offset = Math.max(0, offset - limit);
            loading = false;
            await reload();
            return;
          }
          if (pendingCursor === "last") {
            cursor = Math.max(0, items.length - 1);
            pendingCursor = null;
          } else {
            placeCursor(items);
          }
        } catch (error) {
          if (gen !== loadGen || active !== session) return;
          rows = [];
          total = 0;
          loadError = sanitizeLine(error instanceof Error ? error.message : String(error ?? "error"));
        } finally {
          if (gen === loadGen) loading = false;
          if (gen === loadGen && active === session) session.paint();
        }
      }

      session.paint = () => {
        const { columns, rows: height } = measure(stdout);
        const list = currentRows();
        clampCursor();
        const hint = footer
          ? sanitizeLine(footer)
          : [
              toggle ? "Space toggle" : "",
              multiple ? "Space mark" : "",
              "Enter select",
              "Esc back",
              searchable ? "Type to search" : ""
            ]
              .filter(Boolean)
              .join(" · ");
        const header = titleLines.slice(0, Math.max(1, height - 4));
        const chromeTop = header.length + (searchable ? 2 : 1);
        const chromeBottom = 2;
        const visible = Math.max(1, height - chromeTop - chromeBottom);
        let start = 0;
        if (list.length > visible) {
          start = Math.min(Math.max(0, cursor - Math.floor(visible / 2)), list.length - visible);
        }
        const window = list.slice(start, start + visible);
        const lines = header.map((line) => clip(line, columns));
        if (searchable) lines.push(clip(`Search: ${sanitizeLine(query)}`, columns));
        lines.push("");
        if (loading && list.length === 0) {
          lines.push(clip(loadError || "Loading…", columns));
        } else if (list.length === 0) {
          lines.push(clip(loadError || "No matches", columns));
        } else {
          for (let i = 0; i < window.length; i += 1) {
            const item = window[i];
            const index = start + i;
            const marker = index === cursor ? "> " : "  ";
            const check = multiple ? (selected.has(item.value) ? "[x] " : "[ ] ") : "";
            const desc = item.description ? `  ${sanitizeLine(item.description)}` : "";
            lines.push(formatRow(`${marker}${check}${sanitizeLine(item.label)}${desc}`, index === cursor, columns));
          }
        }
        while (lines.length < height - 2) lines.push("");
        if (loadFn) {
          const from = total === 0 ? 0 : offset + (list.length === 0 ? 0 : 1);
          const to = offset + list.length;
          lines.push(clip(loadError || `${from}–${to} of ${total}`, columns));
        } else {
          lines.push("");
        }
        lines.push(clip(hint, columns));
        paintLines(lines.slice(0, height));
      };

      session.handle = (event) => {
        if (event.type === "resize") {
          if (loadFn) {
            const limit = pageLimit();
            if (limit !== lastLimit) {
              lastLimit = limit;
              void reload();
              return;
            }
          }
          session.paint();
          return;
        }

        const list = currentRows();
        const limit = pageLimit();

        if (event.type === "text") {
          if (event.value === " " && (toggle || multiple) && list[cursor]) {
            const item = list[cursor];
            if (toggle) {
              session.finish({ action: "toggle", value: item.value });
              return;
            }
            if (selected.has(item.value)) selected.delete(item.value);
            else selected.add(item.value);
            session.paint();
            return;
          }
          if (!searchable) return;
          const next = insertableText(event.value, { allowNewline: false });
          if (!next) return;
          const room = MAX_QUERY_CHARS - graphemes(query).length;
          if (room <= 0) return;
          query += graphemes(next).slice(0, room).join("");
          resetSearch();
          if (loadFn) void reload();
          else session.paint();
          return;
        }

        if (event.type !== "key") return;

        if (event.name === "escape") {
          session.finish(null);
          return;
        }
        if (event.name === "enter") {
          if (list.length === 0) return;
          const item = list[cursor];
          if (!item) return;
          if (multiple) session.finish({ action: "select", values: [...selected] });
          else session.finish({ action: "select", value: item.value });
          return;
        }
        if (event.name === "clear" && searchable) {
          if (!query) return;
          query = "";
          resetSearch();
          if (loadFn) void reload();
          else session.paint();
          return;
        }
        if (event.name === "backspace" && searchable) {
          const units = graphemes(query);
          if (units.length === 0) return;
          units.pop();
          query = units.join("");
          resetSearch();
          if (loadFn) void reload();
          else session.paint();
          return;
        }
        if (event.name === "up") {
          if (cursor > 0) cursor -= 1;
          else if (loadFn && offset > 0) {
            offset = Math.max(0, offset - limit);
            pendingCursor = "last";
            void reload();
            return;
          }
          session.paint();
          return;
        }
        if (event.name === "down") {
          if (cursor < list.length - 1) cursor += 1;
          else if (loadFn && offset + list.length < total) {
            offset += limit;
            pendingCursor = null;
            cursor = 0;
            void reload();
            return;
          }
          session.paint();
          return;
        }
        if (event.name === "pageup") {
          if (loadFn) {
            if (offset > 0) {
              offset = Math.max(0, offset - limit);
              cursor = 0;
              void reload();
              return;
            }
            cursor = 0;
          } else {
            cursor = Math.max(0, cursor - limit);
          }
          session.paint();
          return;
        }
        if (event.name === "pagedown") {
          if (loadFn) {
            if (offset + list.length < total) {
              offset += limit;
              cursor = 0;
              void reload();
              return;
            }
            cursor = Math.max(0, list.length - 1);
          } else {
            cursor = Math.min(Math.max(0, list.length - 1), cursor + limit);
          }
          session.paint();
        }
      };

      if (!loadFn) placeCursor(currentRows());
      if (loadFn) void reload();
    });
  }

  /**
   * @param {{ title?: string, value?: string, multiline?: boolean, maxBytes?: number }} options
   */
  function text(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const multiline = options.multiline === true;
    const maxBytes =
      Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : DEFAULT_MAX_BYTES;
    let units = graphemes(typeof options.value === "string" ? options.value : "");
    let cursor = units.length;

    function joined() {
      return units.join("");
    }

    function byteLength(value) {
      return Buffer.byteLength(value, "utf8");
    }

    function insert(raw) {
      const chunk = insertableText(raw, { allowNewline: multiline });
      if (!chunk) return;
      const nextUnits = graphemes(chunk);
      const candidate = [...units.slice(0, cursor), ...nextUnits, ...units.slice(cursor)].join("");
      if (byteLength(candidate) > maxBytes) {
        let accepted = [];
        let prefix = units.slice(0, cursor).join("");
        let suffix = units.slice(cursor).join("");
        for (const g of nextUnits) {
          const trial = prefix + accepted.join("") + g + suffix;
          if (byteLength(trial) > maxBytes) break;
          accepted.push(g);
        }
        if (accepted.length === 0) return;
        units.splice(cursor, 0, ...accepted);
        cursor += accepted.length;
        return;
      }
      units.splice(cursor, 0, ...nextUnits);
      cursor += nextUnits.length;
    }

    function lineBounds(index) {
      let start = index;
      while (start > 0 && units[start - 1] !== "\n") start -= 1;
      let end = index;
      while (end < units.length && units[end] !== "\n") end += 1;
      return { start, end };
    }

    return withPrompt((session) => {
      session.paint = () => {
        const { columns, rows: height } = measure(stdout);
        const hint = multiline ? "Ctrl-S save · Esc cancel" : "Enter save · Esc cancel";
        const lines = joined().split("\n");
        let pos = 0;
        let cursorLine = 0;
        let cursorCol = 0;
        for (let i = 0; i < lines.length; i += 1) {
          const lineUnits = graphemes(lines[i]);
          if (cursor <= pos + lineUnits.length) {
            cursorLine = i;
            cursorCol = cursor - pos;
            break;
          }
          pos += lineUnits.length + 1;
          cursorLine = i;
          cursorCol = lineUnits.length;
        }
        const chrome = 3;
        const bodyRows = Math.max(1, height - chrome);
        let vStart = 0;
        if (cursorLine >= bodyRows) vStart = cursorLine - bodyRows + 1;
        const out = [clip(sanitizeLine(title), columns), clip(hint, columns), ""];
        const slice = lines.slice(vStart, vStart + bodyRows);
        for (let i = 0; i < slice.length; i += 1) {
          const lineIndex = vStart + i;
          const lineUnits = graphemes(slice[i]);
          const activeLine = lineIndex === cursorLine;
          const col = activeLine ? cursorCol : 0;
          let start = 0;
          if (activeLine) {
            while (start < col && displayWidth(lineUnits.slice(start, col).join("")) + 1 > columns) {
              start += 1;
            }
          } else if (displayWidth(slice[i]) > columns) {
            start = 0;
          }
          let rendered = "";
          let used = 0;
          let sawCursor = false;
          for (let u = start; u <= lineUnits.length; u += 1) {
            const atCursor = activeLine && u === col;
            const g = u < lineUnits.length ? lineUnits[u] : "";
            const piece = g || (atCursor ? " " : "");
            if (!piece && !atCursor) break;
            const show = sanitizeDisplay(piece) || (atCursor ? " " : "");
            const w = Math.max(graphemeWidth(show), atCursor ? 1 : 0);
            if (used + w > columns) break;
            if (atCursor) {
              rendered += `${CSI}7m${show || " "}${CSI}0m`;
              sawCursor = true;
            } else {
              rendered += show;
            }
            used += w;
            if (u === lineUnits.length) break;
          }
          if (activeLine && !sawCursor) {
            if (used < columns) rendered += `${CSI}7m ${CSI}0m`;
          }
          out.push(rendered);
        }
        while (out.length < height) out.push("");
        paintLines(out.slice(0, height));
      };

      session.handle = (event) => {
        if (event.type === "resize") {
          session.paint();
          return;
        }
        if (event.type === "text") {
          insert(event.value);
          session.paint();
          return;
        }
        if (event.type !== "key") return;
        if (event.name === "escape") {
          session.finish(null);
          return;
        }
        if (event.name === "save" || (!multiline && event.name === "enter")) {
          session.finish(joined());
          return;
        }
        if (event.name === "enter" && multiline) {
          insert("\n");
          session.paint();
          return;
        }
        if (event.name === "backspace") {
          if (cursor > 0) {
            units.splice(cursor - 1, 1);
            cursor -= 1;
          }
          session.paint();
          return;
        }
        if (event.name === "delete") {
          if (cursor < units.length) units.splice(cursor, 1);
          session.paint();
          return;
        }
        if (event.name === "left") {
          if (cursor > 0) cursor -= 1;
          session.paint();
          return;
        }
        if (event.name === "right") {
          if (cursor < units.length) cursor += 1;
          session.paint();
          return;
        }
        if (event.name === "home") {
          cursor = lineBounds(cursor).start;
          session.paint();
          return;
        }
        if (event.name === "end") {
          cursor = lineBounds(cursor).end;
          session.paint();
          return;
        }
        if (event.name === "up" && multiline) {
          const { start } = lineBounds(cursor);
          if (start === 0) {
            cursor = 0;
          } else {
            const col = cursor - start;
            const prev = lineBounds(start - 1);
            cursor = Math.min(prev.start + col, prev.end);
          }
          session.paint();
          return;
        }
        if (event.name === "down" && multiline) {
          const { start, end } = lineBounds(cursor);
          const col = cursor - start;
          if (end >= units.length) {
            cursor = units.length;
          } else {
            const next = lineBounds(end + 1);
            cursor = Math.min(next.start + col, next.end);
          }
          session.paint();
          return;
        }
        if (event.name === "clear") {
          units = [];
          cursor = 0;
          session.paint();
        }
      };
    });
  }

  /**
   * @param {{ title?: string, text?: string }} options
   */
  function confirm(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const body = typeof options.text === "string" ? options.text : "";
    let cursor = 1;

    return withPrompt((session) => {
      session.paint = () => {
        const { columns, rows: height } = measure(stdout);
        const lines = [clip(sanitizeLine(title), columns), ""];
        const wrapped = wrapLines(body, columns);
        const budget = Math.max(1, height - 6);
        lines.push(...wrapped.slice(0, budget));
        lines.push("");
        lines.push(formatRow(`${cursor === 0 ? "> " : "  "}Yes`, cursor === 0, columns));
        lines.push(formatRow(`${cursor === 1 ? "> " : "  "}No`, cursor === 1, columns));
        while (lines.length < height - 1) lines.push("");
        lines.push(clip("Enter confirm · Esc cancel", columns));
        paintLines(lines.slice(0, height));
      };

      session.handle = (event) => {
        if (event.type === "resize") {
          session.paint();
          return;
        }
        if (event.type === "text") {
          const letter = insertableText(event.value).trim().toLowerCase();
          if (letter === "y") {
            session.finish(true);
            return;
          }
          if (letter === "n") {
            session.finish(false);
            return;
          }
          return;
        }
        if (event.type !== "key") return;
        if (event.name === "escape") {
          session.finish(false);
          return;
        }
        if (event.name === "enter" || event.name === "save") {
          session.finish(cursor === 0);
          return;
        }
        if (event.name === "up" || event.name === "left") {
          cursor = 0;
          session.paint();
          return;
        }
        if (event.name === "down" || event.name === "right") {
          cursor = 1;
          session.paint();
        }
      };
    });
  }

  /**
   * @param {{ title?: string, text?: string }} options
   */
  function notice(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const body = typeof options.text === "string" ? options.text : "";

    return withPrompt((session) => {
      session.paint = () => {
        const { columns, rows: height } = measure(stdout);
        const lines = [clip(sanitizeLine(title), columns), ""];
        lines.push(...wrapLines(body, columns));
        while (lines.length < height - 1) lines.push("");
        lines.push(clip("Press Enter to continue", columns));
        paintLines(lines.slice(0, height));
      };

      session.handle = (event) => {
        if (event.type === "resize") {
          session.paint();
          return;
        }
        if (event.type === "key" && (event.name === "enter" || event.name === "escape" || event.name === "save")) {
          session.finish(undefined);
          return;
        }
        if (event.type === "text" && insertableText(event.value) === " ") {
          session.finish(undefined);
        }
      };
    });
  }

  /**
   * @param {() => Promise<unknown>} fn
   */
  async function suspend(fn) {
    throwIfClosed();
    if (active) throw new TerminalError("busy", "Terminal prompt is already active.");
    detachInputListeners();
    parser.destroy();
    releaseScreen();
    releaseRaw();
    if (typeof stdin.pause === "function") stdin.pause();
    try {
      return await fn();
    } finally {
      if (!closed && !aborted) {
        acquireTerminal();
      }
    }
  }

  function close() {
    shutdown();
  }

  try {
    acquireTerminal();
  } catch (error) {
    restoreTerminal();
    throw error instanceof TerminalError ? error : ttyError();
  }

  return Object.freeze({
    choose,
    text,
    confirm,
    notice,
    suspend,
    close,
    signal: lifecycle.signal
  });
}
