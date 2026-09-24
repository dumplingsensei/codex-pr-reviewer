import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/terminal-ui.mjs
import { stripVTControlCharacters } from "node:util";
var ESC = "\x1B";
var CSI = `${ESC}[`;
var SEQ_ENTER = `${CSI}?1049h${CSI}?25l${CSI}?2004h`;
var SEQ_LEAVE = `${CSI}?2004l${CSI}?25h${CSI}0m${CSI}?1049l`;
var SEQ_HOME_CLEAR = `${CSI}H${CSI}J`;
var ESC_WAIT_MS = 35;
var MAX_LOAD_LIMIT = 40;
var MAX_QUERY_CHARS = 128;
var DEFAULT_MAX_BYTES = 8192;
var DEFAULT_COLUMNS = 80;
var DEFAULT_ROWS = 24;
var PASTE_END = `${CSI}201~`;
var PASTE_TAIL = 6;
var SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
var TerminalError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
  }
};
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
function assertTty(stdin, stdout) {
  if (!stdin || stdin.isTTY !== true || typeof stdin.setRawMode !== "function" || !stdout || stdout.isTTY !== true || typeof stdout.write !== "function") {
    throw ttyError();
  }
}
function graphemes(text) {
  const out = [];
  for (const { segment } of SEGMENTER.segment(String(text ?? ""))) out.push(segment);
  return out;
}
function isZeroWidthCp(cp) {
  if (cp <= 31 || cp === 127) return true;
  if (cp >= 128 && cp <= 159) return true;
  if (cp >= 768 && cp <= 879) return true;
  if (cp >= 6832 && cp <= 6911) return true;
  if (cp >= 7616 && cp <= 7679) return true;
  if (cp >= 8400 && cp <= 8447) return true;
  if (cp >= 65024 && cp <= 65039) return true;
  if (cp >= 65056 && cp <= 65071) return true;
  if (cp >= 917760 && cp <= 917999) return true;
  return cp === 173 || cp === 6158 || cp === 8203 || cp === 8204 || cp === 8205 || cp === 8288 || cp === 65279;
}
function isWideCp(cp) {
  if (cp >= 4352 && cp <= 4447) return true;
  if (cp === 9001 || cp === 9002) return true;
  if (cp >= 11904 && cp <= 42191 && cp !== 12351) return true;
  if (cp >= 44032 && cp <= 55203) return true;
  if (cp >= 63744 && cp <= 64255) return true;
  if (cp >= 65040 && cp <= 65049) return true;
  if (cp >= 65072 && cp <= 65135) return true;
  if (cp >= 65280 && cp <= 65376) return true;
  if (cp >= 65504 && cp <= 65510) return true;
  if (cp >= 110576 && cp <= 110882) return true;
  if (cp >= 126976 && cp <= 129791) return true;
  if (cp >= 131072 && cp <= 262141) return true;
  return false;
}
function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (new RegExp("\\p{Extended_Pictographic}", "u").test(grapheme)) return 2;
  let width = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp === void 0 || isZeroWidthCp(cp)) continue;
    width += isWideCp(cp) ? 2 : 1;
  }
  return width > 2 ? 2 : width;
}
function displayWidth(text) {
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}
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
function padTo(text, columns) {
  const width = displayWidth(text);
  if (width >= columns) return text;
  return text + " ".repeat(columns - width);
}
function sanitizeDisplay(value) {
  const text = stripVTControlCharacters(String(value ?? ""));
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, "");
}
function sanitizeLine(value) {
  return sanitizeDisplay(value).replace(/[\n\r\t]+/g, " ");
}
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
function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.value !== "string" || typeof item.label !== "string") return null;
  return {
    value: item.value,
    label: item.label,
    description: typeof item.description === "string" ? item.description : ""
  };
}
function itemMatches(item, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return item.value.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
}
function insertableText(text, { allowNewline = false } = {}) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  for (const g of graphemes(normalized)) {
    if (g === "\n") {
      out += allowNewline ? "\n" : " ";
      continue;
    }
    if (g === "	") {
      out += " ";
      continue;
    }
    if (graphemeWidth(g) <= 0) continue;
    out += g;
  }
  return out;
}
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
function readEscape(buf) {
  if (buf.length === 0 || buf[0] !== ESC) return { length: 0, event: { type: "key", name: "unknown" } };
  if (buf.length === 1) return { incomplete: true };
  if (buf[1] === "[") {
    let i = 2;
    while (i < buf.length) {
      const code = buf.charCodeAt(i);
      if (code >= 64 && code <= 126) {
        return { length: i + 1, event: csiEvent(buf.slice(2, i), buf[i]) };
      }
      if (code < 32 || code > 63) {
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
      const len = cp > 65535 ? 2 : 1;
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
      if (ch === "") {
        emit({ type: "key", name: "interrupt" });
        continue;
      }
      if (ch === "") {
        emit({ type: "key", name: "eof" });
        continue;
      }
      if (ch === "") {
        emit({ type: "key", name: "save" });
        continue;
      }
      if (ch === "") {
        emit({ type: "key", name: "clear" });
        continue;
      }
      if (ch === "" || ch === "\b") {
        emit({ type: "key", name: "backspace" });
        continue;
      }
      if (ch === "	") {
        emit({ type: "key", name: "tab" });
        continue;
      }
      if (cp !== void 0 && cp < 32) continue;
      let run = ch;
      while (buf.length > 0) {
        const nextCp = buf.codePointAt(0);
        if (nextCp === 27 || nextCp < 32 || nextCp === 127) break;
        const nextLen = nextCp > 65535 ? 2 : 1;
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
      const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
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
function measure(stdout) {
  const columns = Number(stdout.columns);
  const rows = Number(stdout.rows);
  return {
    columns: Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_COLUMNS,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_ROWS
  };
}
function formatRow(body, highlight, columns) {
  const clipped = clip(body, columns);
  const padded = padTo(clipped, columns);
  return highlight ? `${CSI}7m${padded}${CSI}0m` : padded;
}
function createTerminalUI({
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
  function withPrompt(factory) {
    throwIfClosed();
    if (active) {
      return Promise.reject(new TerminalError("busy", "Terminal prompt is already active."));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const session = {
        paint() {
        },
        handle() {
        },
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
  function paintLines(lines) {
    const { columns, rows } = measure(stdout);
    const visible = [];
    for (const line of lines) {
      if (visible.length >= rows) break;
      visible.push(line);
    }
    writeOut(`${SEQ_HOME_CLEAR}${visible.join("\r\n")}`);
  }
  function choose(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const titleLines = title.split(/\r?\n/).map(sanitizeLine);
    const staticItems = Array.isArray(options.items) ? options.items.map(normalizeItem).filter(Boolean) : [];
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
          const items = Array.isArray(result?.items) ? result.items.map(normalizeItem).filter(Boolean) : [];
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
        const hint = footer ? sanitizeLine(footer) : [
          toggle ? "Space toggle" : "",
          multiple ? "Space mark" : "",
          "Enter select",
          "Esc back",
          searchable ? "Type to search" : ""
        ].filter(Boolean).join(" · ");
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
            const check = multiple ? selected.has(item.value) ? "[x] " : "[ ] " : "";
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
            const limit2 = pageLimit();
            if (limit2 !== lastLimit) {
              lastLimit = limit2;
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
  function text(options = {}) {
    const title = typeof options.title === "string" ? options.title : "";
    const multiline = options.multiline === true;
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : DEFAULT_MAX_BYTES;
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
        if (event.name === "save" || !multiline && event.name === "enter") {
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
          session.finish(void 0);
          return;
        }
        if (event.type === "text" && insertableText(event.value) === " ") {
          session.finish(void 0);
        }
      };
    });
  }
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
export {
  TerminalError,
  createTerminalUI
};
