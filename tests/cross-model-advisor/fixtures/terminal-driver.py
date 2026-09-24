#!/usr/bin/env python3
"""Owned POSIX PTY driver for the bundled terminal settings menu.

Node talks JSON lines on this process's stdin/stdout. This process spawns
Node at the requested execPath inside a new session/PTY, owns that process
group, and never touches the caller's controlling terminal.

Commands (one JSON object per line):

  spawn   {execPath, args, env, cwd, cols, rows}
  write   {data} | {base64}
  keys    {keys: ["ENTER","DOWN",...]}
  paste   {text, bracketed?}
  resize  {cols, rows}
  signal  {name: "SIGINT"|"SIGTERM"|...}
  wait    {contains? | regex?, timeoutMs}
  wait_exit {timeoutMs}
  snapshot
  termios
  close
  kill
"""

from __future__ import annotations

import atexit
import base64
import codecs
import errno
import fcntl
import json
import os
import re
import select
import signal
import struct
import sys
import termios
import time
import tty
import unicodedata

KEYS = {
    "ENTER": "\r",
    "RETURN": "\r",
    "ESC": "\x1b",
    "ESCAPE": "\x1b",
    "SPACE": " ",
    "TAB": "\t",
    "UP": "\x1b[A",
    "DOWN": "\x1b[B",
    "RIGHT": "\x1b[C",
    "LEFT": "\x1b[D",
    "HOME": "\x1b[H",
    "END": "\x1b[F",
    "PGUP": "\x1b[5~",
    "PGDN": "\x1b[6~",
    "BACKSPACE": "\x7f",
    "DELETE": "\x1b[3~",
    "CTRL_A": "\x01",
    "CTRL_C": "\x03",
    "CTRL_D": "\x04",
    "CTRL_E": "\x05",
    "CTRL_K": "\x0b",
    "CTRL_L": "\x0c",
    "CTRL_S": "\x13",
    "CTRL_U": "\x15",
    "CTRL_Z": "\x1a",
}

SIGNALS = {
    "SIGINT": signal.SIGINT,
    "SIGTERM": signal.SIGTERM,
    "SIGHUP": signal.SIGHUP,
    "SIGQUIT": signal.SIGQUIT,
    "SIGKILL": signal.SIGKILL,
    "SIGWINCH": signal.SIGWINCH,
}

TIOCSWINSZ = getattr(termios, "TIOCSWINSZ", None)
TIOCSCTTY = getattr(tty, "TIOCSCTTY", 0x20007461 if sys.platform == "darwin" else None)


def _east_width(ch: str) -> int:
    if ch == "\x00" or unicodedata.combining(ch):
        return 0
    if ch in ("\n", "\r"):
        return 0
    code = ord(ch)
    if code < 32 or (0x7F <= code < 0xA0):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Screen:
    """Minimal cursor-addressable buffer for waiting on actual frames."""

    def __init__(self, rows: int, cols: int):
        self.rows = max(2, int(rows))
        self.cols = max(8, int(cols))
        self.row = 0
        self.col = 0
        self.inverse = False
        self._primary = self._blank()
        self._primary_attr = self._blank_attr()
        self._alt = self._blank()
        self._alt_attr = self._blank_attr()
        self._use_alt = False
        self._saved = (0, 0)
        self._esc = ""
        self._osc = False

    def _blank(self):
        return [[" "] * self.cols for _ in range(self.rows)]

    def _blank_attr(self):
        return [[False] * self.cols for _ in range(self.rows)]

    def _cells(self):
        return self._alt if self._use_alt else self._primary

    def _attrs(self):
        return self._alt_attr if self._use_alt else self._primary_attr

    def resize(self, rows: int, cols: int) -> None:
        rows = max(2, int(rows))
        cols = max(8, int(cols))
        if rows == self.rows and cols == self.cols:
            return
        for grid, blank in (
            (self._primary, " "),
            (self._alt, " "),
        ):
            self._fit_grid(grid, rows, cols, blank)
        for grid in (self._primary_attr, self._alt_attr):
            self._fit_grid(grid, rows, cols, False)
        self.rows = rows
        self.cols = cols
        self.row = min(self.row, rows - 1)
        self.col = min(self.col, cols - 1)

    def _fit_grid(self, grid, rows, cols, fill):
        if len(grid) < rows:
            width = len(grid[0]) if grid else cols
            grid.extend([[fill] * width for _ in range(rows - len(grid))])
        del grid[rows:]
        for i, line in enumerate(grid):
            if len(line) < cols:
                line.extend([fill] * (cols - len(line)))
            del line[cols:]
            grid[i] = line

    def text(self) -> str:
        lines = []
        for row in self._cells():
            lines.append("".join(row).rstrip())
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines)

    def highlighted(self):
        found = []
        attrs = self._attrs()
        cells = self._cells()
        for r in range(self.rows):
            run = []
            for c in range(self.cols):
                if attrs[r][c]:
                    run.append(cells[r][c])
                elif run:
                    label = "".join(run).strip()
                    if label:
                        found.append(label)
                    run = []
            if run:
                label = "".join(run).strip()
                if label:
                    found.append(label)
        return found

    def feed(self, text: str) -> None:
        i = 0
        n = len(text)
        while i < n:
            if self._esc:
                self._esc += text[i]
                i += 1
                if self._osc:
                    if self._esc.endswith("\x07") or self._esc.endswith("\x1b\\"):
                        self._esc = ""
                        self._osc = False
                    elif len(self._esc) > 1024:
                        self._esc = ""
                        self._osc = False
                    continue
                if self._esc == "\x1b]":
                    self._osc = True
                    continue
                if self._esc in ("\x1b7", "\x1b8", "\x1bM", "\x1bc"):
                    if self._esc == "\x1b7":
                        self._saved = (self.row, self.col)
                    elif self._esc == "\x1b8":
                        self.row, self.col = self._saved
                    elif self._esc == "\x1bc":
                        self._reset_current()
                    self._esc = ""
                    continue
                if self._esc == "\x1b[" or (
                    self._esc.startswith("\x1b[") and not self._esc[-1].isalpha() and self._esc[-1] not in "@`~"
                ):
                    if len(self._esc) > 64:
                        self._esc = ""
                    continue
                if self._esc.startswith("\x1b["):
                    self._csi(self._esc[2:])
                self._esc = ""
                continue
            ch = text[i]
            i += 1
            if ch == "\x1b":
                self._esc = "\x1b"
                continue
            if ch == "\r":
                self.col = 0
                continue
            if ch == "\n":
                self._lf()
                continue
            if ch == "\b":
                self.col = max(0, self.col - 1)
                continue
            if ch == "\t":
                self.col = min(self.cols - 1, (self.col + 8) // 8 * 8)
                continue
            if ch == "\x07":
                continue
            if ord(ch) < 32:
                continue
            width = _east_width(ch) or 1
            if self.col + width > self.cols:
                self.col = 0
                self._lf()
            cells = self._cells()
            attrs = self._attrs()
            if 0 <= self.row < self.rows and 0 <= self.col < self.cols:
                cells[self.row][self.col] = ch
                attrs[self.row][self.col] = self.inverse
                for extra in range(1, width):
                    if self.col + extra < self.cols:
                        cells[self.row][self.col + extra] = " "
                        attrs[self.row][self.col + extra] = self.inverse
            self.col += width

    def _reset_current(self) -> None:
        grid = self._cells()
        attrs = self._attrs()
        for r in range(self.rows):
            for c in range(self.cols):
                grid[r][c] = " "
                attrs[r][c] = False
        self.row = 0
        self.col = 0
        self.inverse = False

    def _lf(self) -> None:
        if self.row + 1 < self.rows:
            self.row += 1
            return
        cells = self._cells()
        attrs = self._attrs()
        cells.pop(0)
        attrs.pop(0)
        cells.append([" "] * self.cols)
        attrs.append([False] * self.cols)

    def _csi(self, body: str) -> None:
        if not body:
            return
        final = body[-1]
        raw = body[:-1]
        priv = ""
        if raw.startswith("?") or raw.startswith(">"):
            priv = raw[0]
            raw = raw[1:]
        parts = raw.split(";") if raw else []
        nums = []
        for part in parts:
            if part == "":
                nums.append(0)
            else:
                try:
                    nums.append(int(part))
                except ValueError:
                    nums.append(0)
        n = nums[0] if nums else 0
        m = nums[1] if len(nums) > 1 else 0
        if final in ("H", "f"):
            self.row = min(self.rows - 1, max(0, (n or 1) - 1))
            self.col = min(self.cols - 1, max(0, (m or 1) - 1))
        elif final == "A":
            self.row = max(0, self.row - (n or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (n or 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (n or 1))
        elif final == "D":
            self.col = max(0, self.col - (n or 1))
        elif final == "G":
            self.col = min(self.cols - 1, max(0, (n or 1) - 1))
        elif final == "d":
            self.row = min(self.rows - 1, max(0, (n or 1) - 1))
        elif final == "J":
            self._erase_display(n)
        elif final == "K":
            self._erase_line(n)
        elif final == "m":
            self._sgr(nums or [0])
        elif final == "s":
            self._saved = (self.row, self.col)
        elif final == "u":
            self.row, self.col = self._saved
        elif final == "h" and priv == "?":
            if n == 1049 or n == 47:
                self._use_alt = True
                self._reset_current()
        elif final == "l" and priv == "?":
            if n == 1049 or n == 47:
                self._use_alt = False
                self.row = 0
                self.col = 0

    def _sgr(self, nums) -> None:
        if not nums:
            nums = [0]
        for value in nums:
            if value == 0:
                self.inverse = False
            elif value == 7:
                self.inverse = True
            elif value == 27:
                self.inverse = False

    def _erase_display(self, mode: int) -> None:
        cells = self._cells()
        attrs = self._attrs()
        if mode == 2 or mode == 3:
            self._reset_current()
            return
        if mode == 0:
            self._erase_line(0)
            for r in range(self.row + 1, self.rows):
                for c in range(self.cols):
                    cells[r][c] = " "
                    attrs[r][c] = False
            return
        if mode == 1:
            for r in range(0, self.row):
                for c in range(self.cols):
                    cells[r][c] = " "
                    attrs[r][c] = False
            self._erase_line(1)

    def _erase_line(self, mode: int) -> None:
        cells = self._cells()
        attrs = self._attrs()
        if not (0 <= self.row < self.rows):
            return
        start = 0
        end = self.cols
        if mode == 0:
            start = self.col
        elif mode == 1:
            end = self.col + 1
        for c in range(start, end):
            cells[self.row][c] = " "
            attrs[self.row][c] = False


class PtySession:
    def __init__(self):
        self.master = None
        self.slave = None
        self.pid = None
        self.pgid = None
        self.cols = 80
        self.rows = 24
        self.screen = Screen(self.rows, self.cols)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.transcript = []
        self.exited = False
        self.exit_status = None
        self.exit_signal = None
        self.wait_deadline = None
        self.wait_contains = None
        self.wait_regex = None
        self.wait_id = None
        self._killed = False
        self._termios_last = None

    def spawn(self, msg: dict) -> dict:
        if self.pid is not None:
            raise RuntimeError("already spawned")
        exec_path = msg.get("execPath")
        if not isinstance(exec_path, str) or not exec_path:
            raise RuntimeError("spawn requires execPath")
        args = msg.get("args") or []
        if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
            raise RuntimeError("args must be a list of strings")
        cwd = msg.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise RuntimeError("cwd must be a string")
        env_in = msg.get("env") or {}
        if not isinstance(env_in, dict):
            raise RuntimeError("env must be an object")
        self.cols = int(msg.get("cols") or 80)
        self.rows = int(msg.get("rows") or 24)
        self.screen = Screen(self.rows, self.cols)
        env = {}
        for key, value in os.environ.items():
            env[key] = value
        for key, value in env_in.items():
            if value is None:
                env.pop(str(key), None)
            else:
                env[str(key)] = str(value)
        env["TERM"] = env.get("TERM") or "xterm-256color"
        env["COLUMNS"] = str(self.cols)
        env["LINES"] = str(self.rows)
        env.pop("NODE_OPTIONS", None)

        master, slave = os.openpty()
        self._set_winsize(master, self.rows, self.cols)
        self._set_winsize(slave, self.rows, self.cols)
        attrs = termios.tcgetattr(slave)
        attrs[3] |= termios.ICANON | termios.ECHO | termios.ISIG
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        pid = os.fork()
        if pid == 0:
            try:
                os.close(master)
                os.setsid()
                if TIOCSCTTY is not None:
                    try:
                        fcntl.ioctl(slave, TIOCSCTTY, 0)
                    except OSError:
                        pass
                os.dup2(slave, 0)
                os.dup2(slave, 1)
                os.dup2(slave, 2)
                if slave > 2:
                    os.close(slave)
                if cwd:
                    os.chdir(cwd)
                os.execve(exec_path, [exec_path, *args], env)
            except Exception:
                os._exit(127)
        os.close(slave) if False else None
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        try:
            fcntl.fcntl(slave, fcntl.F_SETFD, fcntl.FD_CLOEXEC)
        except Exception:
            pass
        self.master = master
        self.slave = slave
        self.pid = pid
        # The child becomes its own group leader in setsid(). Reading getpgid
        # here races that call and can capture (then kill) the driver's group.
        self.pgid = pid
        self._termios()
        return {"pid": pid, "pgid": self.pgid, "cols": self.cols, "rows": self.rows}

    def write_text(self, data: str) -> None:
        self._ensure_live()
        raw = data.encode("utf-8")
        while raw:
            try:
                written = os.write(self.master, raw)
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EINTR):
                    time.sleep(0.01)
                    continue
                raise
            raw = raw[written:]

    def keys(self, names) -> None:
        out = []
        for name in names:
            if not isinstance(name, str):
                raise RuntimeError("key names must be strings")
            if name.startswith("TEXT:"):
                out.append(name[5:])
                continue
            mapped = KEYS.get(name.upper())
            if mapped is None:
                if len(name) == 1:
                    out.append(name)
                else:
                    raise RuntimeError("unknown key %s" % name)
            else:
                out.append(mapped)
        self.write_text("".join(out))

    def paste(self, text: str, bracketed: bool) -> None:
        if not isinstance(text, str):
            raise RuntimeError("paste text must be a string")
        if bracketed:
            self.write_text("\x1b[200~" + text + "\x1b[201~")
        else:
            self.write_text(text)

    def resize(self, cols: int, rows: int) -> None:
        self.cols = int(cols)
        self.rows = int(rows)
        self.screen.resize(self.rows, self.cols)
        if self.master is not None:
            self._set_winsize(self.master, self.rows, self.cols)
        if self.slave is not None:
            try:
                self._set_winsize(self.slave, self.rows, self.cols)
            except OSError:
                pass
        self._killpg(signal.SIGWINCH)

    def signal_child(self, name: str) -> None:
        sig = SIGNALS.get(str(name).upper())
        if sig is None:
            raise RuntimeError("unknown signal %s" % name)
        self._killpg(sig)

    def snapshot(self) -> dict:
        self._reap(False)
        self._drain()
        return self._view()

    def begin_wait(self, msg_id, contains, regex, timeout_ms) -> None:
        self.wait_id = msg_id
        self.wait_contains = contains
        self.wait_regex = re.compile(regex) if regex else None
        timeout_ms = 5000 if timeout_ms is None else int(timeout_ms)
        if timeout_ms <= 0:
            raise RuntimeError("timeoutMs must be positive")
        self.wait_deadline = time.time() + (timeout_ms / 1000.0)

    def wait_ready(self):
        if self.wait_id is None:
            return None
        self._reap(False)
        self._drain()
        if self._matches():
            result = self._view()
            result["matched"] = True
            wait_id = self.wait_id
            self._clear_wait()
            return wait_id, result
        if self.exited:
            result = self._view()
            result["matched"] = False
            result["error"] = "process exited before match"
            wait_id = self.wait_id
            self._clear_wait()
            return wait_id, result
        if time.time() >= self.wait_deadline:
            result = self._view()
            result["ok"] = False
            result["matched"] = False
            result["error"] = "timeout waiting for screen\n%s" % result.get("screen", "")
            wait_id = self.wait_id
            self._clear_wait()
            return wait_id, result
        return None

    def termios_state(self) -> dict:
        return self._termios()

    def close(self, kill: bool) -> dict:
        if kill:
            self._killpg(signal.SIGKILL)
        else:
            self._killpg(signal.SIGTERM)
        deadline = time.time() + (0.4 if kill else 2.0)
        while not self.exited and time.time() < deadline:
            self._reap(False)
            self._drain()
            self._termios()
            time.sleep(0.02)
        if not self.exited:
            self._killpg(signal.SIGKILL)
            deadline = time.time() + 0.8
            while not self.exited and time.time() < deadline:
                self._reap(False)
                self._termios()
                time.sleep(0.02)
        self._reap(True)
        self._drain()
        view = self._view()
        view["termios"] = self._termios()
        self._close_fds()
        return view

    def wait_exit(self, timeout_ms) -> dict:
        timeout_ms = 5000 if timeout_ms is None else int(timeout_ms)
        if timeout_ms <= 0:
            raise RuntimeError("timeoutMs must be positive")
        deadline = time.time() + (timeout_ms / 1000.0)
        while time.time() < deadline:
            self._reap(False)
            self._drain()
            self._termios()
            if self.exited:
                view = self._view()
                view["termios"] = self._termios()
                return view
            time.sleep(0.005)
        self._reap(False)
        self._drain()
        view = self._view()
        raise RuntimeError("timeout waiting for exit\n%s" % view.get("screen", ""))

    def shutdown(self) -> None:
        if self.pid is not None and not self.exited:
            self.close(True)
        else:
            self._close_fds()

    def _matches(self) -> bool:
        text = self.screen.text()
        transcript = "".join(self.transcript)
        hay = text + "\n" + transcript
        if self.wait_contains is not None and self.wait_contains not in hay and self.wait_contains not in text:
            return False
        if self.wait_contains is not None and (
            self.wait_contains in text or self.wait_contains in hay
        ):
            if self.wait_regex is None:
                return True
        if self.wait_contains is None and self.wait_regex is None:
            return True
        if self.wait_regex is not None:
            return self.wait_regex.search(text) is not None or self.wait_regex.search(hay) is not None
        return False

    def _clear_wait(self) -> None:
        self.wait_id = None
        self.wait_contains = None
        self.wait_regex = None
        self.wait_deadline = None

    def _view(self) -> dict:
        return {
            "ok": True,
            "pid": self.pid,
            "exited": self.exited,
            "exitStatus": self.exit_status,
            "exitSignal": self.exit_signal,
            "screen": self.screen.text(),
            "highlighted": self.screen.highlighted(),
            "transcript": "".join(self.transcript),
            "cursor": [self.screen.row, self.screen.col],
            "cols": self.cols,
            "rows": self.rows,
            "termios": self._termios(),
        }

    def _read_termios(self):
        for fd in (self.slave, self.master):
            if fd is None:
                continue
            try:
                attrs = termios.tcgetattr(fd)
            except (termios.error, OSError):
                continue
            lflag = attrs[3]
            icanon = bool(lflag & termios.ICANON)
            echo = bool(lflag & termios.ECHO)
            return {
                "available": True,
                "icanon": icanon,
                "echo": echo,
                "isig": bool(lflag & termios.ISIG),
                "restored": icanon and echo,
            }
        return None

    def _termios(self) -> dict:
        observed = self._read_termios()
        if observed is not None:
            self._termios_last = observed
            return dict(observed)
        if self._termios_last is not None:
            return dict(self._termios_last)
        return {"available": False}

    def _ensure_live(self) -> None:
        self._reap(False)
        if self.exited or self.master is None:
            raise RuntimeError("child is not running")

    def _drain(self) -> None:
        if self.master is None:
            return
        while True:
            try:
                chunk = os.read(self.master, 8192)
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                    return
                return
            if not chunk:
                return
            text = self.decoder.decode(chunk)
            if text:
                self.transcript.append(text)
                if len(self.transcript) > 4000:
                    self.transcript = self.transcript[-2000:]
                self.screen.feed(text)

    def _reap(self, block: bool) -> None:
        if self.pid is None or self.exited:
            return
        flags = 0 if block else os.WNOHANG
        try:
            waited, status = os.waitpid(self.pid, flags)
        except OSError:
            self.exited = True
            self._termios()
            return
        if waited == 0:
            return
        self.exited = True
        if os.WIFEXITED(status):
            self.exit_status = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            self.exit_signal = os.WTERMSIG(status)
            self.exit_status = 128 + self.exit_signal
        self._drain()
        self._termios()

    def _killpg(self, sig) -> None:
        if self.pgid is None:
            return
        try:
            os.killpg(self.pgid, sig)
        except OSError:
            if self.pid is not None:
                try:
                    os.kill(self.pid, sig)
                except OSError:
                    pass

    def _close_fds(self) -> None:
        self._termios()
        for fd_name in ("master", "slave"):
            fd = getattr(self, fd_name)
            if fd is None:
                continue
            try:
                os.close(fd)
            except OSError:
                pass
            setattr(self, fd_name, None)

    def _set_winsize(self, fd, rows, cols) -> None:
        if TIOCSWINSZ is None or fd is None:
            return
        packed = struct.pack("HHHH", int(rows), int(cols), 0, 0)
        fcntl.ioctl(fd, TIOCSWINSZ, packed)


def reply(msg_id, payload: dict) -> None:
    payload = dict(payload)
    payload["id"] = msg_id
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(msg_id, error: str) -> None:
    reply(msg_id, {"ok": False, "error": str(error)})


def main() -> int:
    session = PtySession()
    atexit.register(session.shutdown)
    stdin_fd = sys.stdin.fileno()
    incoming = b""
    try:
        while True:
            timeout = None
            if session.wait_deadline is not None:
                timeout = max(0.0, min(0.05, session.wait_deadline - time.time()))
            fds = [stdin_fd]
            if session.master is not None and not session.exited:
                fds.append(session.master)
            try:
                readable, _, _ = select.select(fds, [], [], timeout)
            except (select.error, InterruptedError):
                continue
            if session.master in readable:
                session._drain()
            ready = session.wait_ready()
            if ready is not None:
                wait_id, payload = ready
                if payload.get("ok", True) is False:
                    fail(wait_id, payload.get("error") or "wait failed")
                else:
                    reply(wait_id, payload)
            if stdin_fd not in readable:
                continue
            try:
                chunk = os.read(stdin_fd, 8192)
            except OSError as error:
                if error.errno == errno.EINTR:
                    continue
                break
            if not chunk:
                break
            incoming += chunk
            while b"\n" in incoming:
                line, incoming = incoming.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception as error:
                    fail(None, "invalid json: %s" % error)
                    continue
                msg_id = msg.get("id")
                op = msg.get("op")
                try:
                    if op == "spawn":
                        reply(msg_id, {"ok": True, **session.spawn(msg)})
                    elif op == "write":
                        if "base64" in msg:
                            data = base64.b64decode(msg["base64"]).decode("utf-8")
                        else:
                            data = msg.get("data") or ""
                        session.write_text(data)
                        reply(msg_id, {"ok": True})
                    elif op == "keys":
                        session.keys(msg.get("keys") or [])
                        reply(msg_id, {"ok": True})
                    elif op == "paste":
                        session.paste(msg.get("text") or "", bool(msg.get("bracketed")))
                        reply(msg_id, {"ok": True})
                    elif op == "resize":
                        session.resize(msg.get("cols") or session.cols, msg.get("rows") or session.rows)
                        reply(msg_id, {"ok": True})
                    elif op == "signal":
                        session.signal_child(msg.get("name") or "")
                        reply(msg_id, {"ok": True})
                    elif op == "wait":
                        session.begin_wait(
                            msg_id,
                            msg.get("contains"),
                            msg.get("regex"),
                            msg.get("timeoutMs"),
                        )
                    elif op == "snapshot":
                        reply(msg_id, session.snapshot())
                    elif op == "termios":
                        reply(msg_id, {"ok": True, "termios": session.termios_state()})
                    elif op == "close":
                        reply(msg_id, {"ok": True, **session.close(False)})
                    elif op == "kill":
                        reply(msg_id, {"ok": True, **session.close(True)})
                    elif op == "wait_exit":
                        reply(msg_id, {"ok": True, **session.wait_exit(msg.get("timeoutMs"))})
                    else:
                        fail(msg_id, "unknown op %s" % op)
                except Exception as error:
                    fail(msg_id, str(error))
    finally:
        session.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
