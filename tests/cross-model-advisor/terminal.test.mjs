/**
 * Boundary tests for raw-terminal primitives: non-TTY, cancel vs abort,
 * bracketed paste, UTF-8 splits, and display sanitization. Imports source
 * (no package dependencies). Real PTY coverage lives with the menu tests.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { TerminalError, createTerminalUI } = await import(
  pathToFileURL(path.join(repo, "plugins", "cross-model-advisor", "src", "terminal-ui.mjs")).href
);

function ttyStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (value) => {
    stream.isRaw = Boolean(value);
    return stream;
  };
  return stream;
}

function collectStdout() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
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

async function waitForText(stdout, needle, timeoutMs = 1000) {
  const start = Date.now();
  while (!stdout.text.includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`missing ${JSON.stringify(needle)} in ${JSON.stringify(stdout.text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("non-TTY and aborted signal reject before raw mode or screen writes", () => {
  let raw = false;
  let written = false;
  const watchRaw = () => {
    raw = true;
  };
  const watchWrite = () => {
    written = true;
    return true;
  };

  const stdin = new PassThrough();
  stdin.isTTY = false;
  stdin.setRawMode = watchRaw;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.write = watchWrite;
  assert.throws(() => createTerminalUI({ stdin, stdout }), (error) => {
    assert.equal(error instanceof TerminalError, true);
    assert.equal(error.code, "tty");
    return true;
  });
  assert.equal(raw, false);
  assert.equal(written, false);

  const stdinTty = new PassThrough();
  stdinTty.isTTY = true;
  stdinTty.setRawMode = watchRaw;
  const stdoutPlain = new PassThrough();
  stdoutPlain.isTTY = false;
  stdoutPlain.write = watchWrite;
  assert.throws(() => createTerminalUI({ stdin: stdinTty, stdout: stdoutPlain }), (error) => {
    assert.equal(error.code, "tty");
    return true;
  });
  assert.equal(raw, false);
  assert.equal(written, false);

  const ac = new AbortController();
  ac.abort();
  const liveIn = ttyStdin();
  const liveOut = collectStdout();
  liveOut.write = function write(chunk, ...rest) {
    written = true;
    return PassThrough.prototype.write.call(this, chunk, ...rest);
  };
  assert.throws(() => createTerminalUI({ stdin: liveIn, stdout: liveOut, signal: ac.signal }), (error) => {
    assert.equal(error.code, "abort");
    return true;
  });
  assert.equal(liveIn.isRaw, false);
  assert.equal(written, false);
});

test("Esc cancels choose and text with null; confirm is false", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  try {
    const chooseP = ui.choose({
      title: "Pick",
      items: [{ value: "a", label: "Alpha" }]
    });
    await waitForText(stdout, "Pick");
    stdin.write("\x1b");
    assert.equal(await chooseP, null);
    assert.equal(stdin.isRaw, true);

    const textP = ui.text({ title: "Name", value: "keep" });
    await waitForText(stdout, "Name");
    stdin.write("\x1b");
    assert.equal(await textP, null);

    const confirmP = ui.confirm({ title: "Sure", text: "Discard?" });
    await waitForText(stdout, "Sure");
    stdin.write("\x1b");
    assert.equal(await confirmP, false);
    assert.equal(stdin.isRaw, true);
  } finally {
    ui.close();
  }
  assert.equal(stdin.isRaw, false);
});

test("Ctrl-C, EOF, and AbortSignal abort and restore the terminal", async () => {
  {
    const stdin = ttyStdin();
    const stdout = collectStdout();
    const ui = createTerminalUI({ stdin, stdout });
    const pending = ui.choose({ title: "Pick", items: [{ value: "a", label: "Alpha" }] });
    await waitForText(stdout, "Pick");
    stdin.write("\x03");
    await assert.rejects(pending, (error) => error.code === "abort" && error.name === "AbortError");
    assert.equal(stdin.isRaw, false);
    assert.equal(ui.signal.aborted, true);
    ui.close();
  }
  {
    const stdin = ttyStdin();
    const stdout = collectStdout();
    const ui = createTerminalUI({ stdin, stdout });
    const pending = ui.text({ title: "Ed" });
    await waitForText(stdout, "Ed");
    stdin.end();
    await assert.rejects(pending, (error) => error.code === "abort" && error.name === "AbortError");
    assert.equal(stdin.isRaw, false);
    assert.equal(ui.signal.aborted, true);
    ui.close();
  }
  {
    const stdin = ttyStdin();
    const stdout = collectStdout();
    const ac = new AbortController();
    const ui = createTerminalUI({ stdin, stdout, signal: ac.signal });
    const pending = ui.choose({ title: "Pick", items: [{ value: "a", label: "Alpha" }] });
    await waitForText(stdout, "Pick");
    ac.abort();
    await assert.rejects(pending, (error) => error.code === "abort" || error.name === "AbortError");
    assert.equal(stdin.isRaw, false);
    assert.equal(ui.signal.aborted, true);
    ui.close();
  }
});

test("bracketed paste cannot save or cancel the editor", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  try {
    const pending = ui.text({ title: "Instr", value: "", multiline: true });
    await waitForText(stdout, "Instr");
    stdin.write("\x1b[200~\x13\x1bkeep\x03\x1b[201~");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("more");
    stdin.write("\x13");
    assert.equal(await pending, "keepmore");
  } finally {
    ui.close();
  }
});

test("split UTF-8 bytes assemble into editor text", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  try {
    const pending = ui.text({ title: "Ed", value: "" });
    await waitForText(stdout, "Ed");
    const bytes = Buffer.from("é你", "utf8");
    stdin.write(bytes.subarray(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write(bytes.subarray(1));
    stdin.write("\r");
    assert.equal(await pending, "é你");
  } finally {
    ui.close();
  }
});

test("renderer does not execute CSI from labels", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  try {
    const pending = ui.choose({
      title: "Pick",
      items: [{ value: "x", label: "\x1b[31mRed\x1b[0m" }]
    });
    await waitForText(stdout, "Red");
    assert.equal(stdout.text.includes("\x1b[31m"), false);
    stdin.write("\x1b");
    assert.equal(await pending, null);
  } finally {
    ui.close();
  }
});

test("stale loader results cannot win over a newer query", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  let releaseSlow;
  const slow = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const load = async ({ query }) => {
    if (query === "a") {
      await slow;
      return { items: [{ value: "stale", label: "StaleItem" }], total: 1 };
    }
    if (query === "ab") {
      return { items: [{ value: "fresh", label: "FreshItem" }], total: 1 };
    }
    return { items: [], total: 0 };
  };
  try {
    const pending = ui.choose({ title: "Models", search: true, load });
    await waitForText(stdout, "Models");
    stdin.write("a");
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write("b");
    await waitForText(stdout, "FreshItem");
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\r");
    assert.deepEqual(await pending, { action: "select", value: "fresh" });
  } finally {
    ui.close();
  }
});

test("suspend releases stdin handlers and close is idempotent", async () => {
  const stdin = ttyStdin();
  const stdout = collectStdout();
  const ui = createTerminalUI({ stdin, stdout });
  try {
    assert.equal(stdin.isRaw, true);
    assert.ok(stdin.listenerCount("data") > 0);
    assert.equal(ui.signal.aborted, false);
    let inside = false;
    await ui.suspend(async () => {
      inside = true;
      assert.equal(stdin.isRaw, false);
      assert.equal(stdin.listenerCount("data"), 0);
      assert.equal(ui.signal.aborted, false);
    });
    assert.equal(inside, true);
    assert.equal(stdin.isRaw, true);
    assert.ok(stdin.listenerCount("data") > 0);
    ui.close();
    ui.close();
    assert.equal(ui.signal.aborted, true);
    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.listenerCount("data"), 0);
  } finally {
    ui.close();
  }
});

test("abort during suspend restores the terminal and lets cleanup finish", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");

  {
    const stdin = ttyStdin();
    const stdout = collectStdout();
    const ui = createTerminalUI({ stdin, stdout });
    try {
      let cleaned = false;
      const pending = ui.suspend(async () => {
        assert.equal(stdin.isRaw, false);
        assert.equal(stdin.listenerCount("data"), 0);
        const aborted = new Promise((resolve) => {
          ui.signal.addEventListener("abort", resolve, { once: true });
        });
        process.emit("SIGTERM");
        await aborted;
        assert.equal(ui.signal.aborted, true);
        assert.equal(stdin.isRaw, false);
        cleaned = true;
      });
      await pending;
      assert.equal(cleaned, true);
      assert.equal(ui.signal.aborted, true);
      assert.equal(stdin.isRaw, false);
    } finally {
      ui.close();
      ui.close();
    }
  }

  {
    const stdin = ttyStdin();
    const stdout = collectStdout();
    const ac = new AbortController();
    const ui = createTerminalUI({ stdin, stdout, signal: ac.signal });
    try {
      let cleaned = false;
      const pending = ui.suspend(async () => {
        const aborted = new Promise((resolve) => {
          ui.signal.addEventListener("abort", resolve, { once: true });
        });
        ac.abort();
        await aborted;
        assert.equal(ui.signal.aborted, true);
        assert.equal(stdin.isRaw, false);
        cleaned = true;
      });
      await pending;
      assert.equal(cleaned, true);
    } finally {
      ui.close();
    }
  }

  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
});
