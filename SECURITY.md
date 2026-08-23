# Security policy

## Why this plugin has a threat model

`codex-pr-reviewer` fetches pull requests written by strangers, checks them out
into a working tree on your machine, and runs a model over them. Three things
follow from that, and they are what this policy is about:

- **Checking out a pull request writes attacker-authored bytes to disk.** That
  happens before any sandbox exists, and `git` executes hooks and filters while
  it does it.
- **The reviewer reads the code it is reviewing.** Anything a pull request can
  put in front of Codex — source, comments, test fixtures, project documents —
  is text that will try to be read as instructions.
- **The plugin writes into your real repositories.** Branches, refs, and
  worktrees are created inside whichever checkout hosted the pull request, and
  `clean` deletes them again.

Reports about any of those are wanted.

## Reporting a vulnerability

Use **[private vulnerability reporting](https://github.com/dumplingsensei/codex-pr-reviewer/security/advisories/new)**
— the *Security* tab, then *Report a vulnerability*. It is private between you
and the maintainer until an advisory is published.

Please do **not** open a public issue for a security problem. A public issue
discloses it to everyone at once, including to people running the plugin who
have not yet updated.

A useful report says what an attacker controls, what they get, and how you
established it. A proof of concept against a scratch repository is worth more
than a description; a description is worth more than nothing.

Expect an acknowledgement within a week. This is a personal project maintained
in spare time, so please read that as an honest estimate rather than an SLA.

## Supported versions

The most recent release only. Versions are listed in
[CHANGELOG.md](CHANGELOG.md) and tagged `v<version>`.

Claude Code resolves an install by version and caches it, so a fix reaches you
only after `claude plugin update codex-pr-reviewer@dumplingsensei-plugins` **and** a
restart of Claude Code. `doctor` reports when the copy a session is running is
older than what is installed.

## In scope

- Execution of pull-request-controlled code anywhere in the flow — hooks,
  filters, project configuration, build or test invocation.
- Anything that lets a pull request steer the review of itself, such as reaching
  Codex's instructions from inside the checkout.
- Reading or writing outside the plugin's own cache and the branches and refs it
  records: path traversal, a manifest that directs a delete somewhere it should
  not reach, a symlink that escapes a worktree.
- Fetching code from one place while reporting metadata from another.
- Anything that gets the plugin to act on someone else's repository, or on a
  pull request other than the one named.
- Leaking local paths, tokens, or private code into a saved review.

## Known and accepted

These are deliberate, documented in the README, and not treated as
vulnerabilities on their own. A concrete exploit that turns one into something
worse *is* in scope.

- **Pre-approval is not a sandbox.** `allowed-tools` grants permission; it does
  not remove capability. A narrow rule makes an unexpected command prompt you
  rather than run silently, which is the boundary — not a wall.
- **Filter drivers other than Git LFS.** Hooks are disabled and LFS filters are
  neutralised for every git this plugin runs. A driver you have configured under
  some other name that a pull request can guess is not covered; closing that
  completely needs a plugin-owned clone with its own configuration.
- **`-s read-only` bounds writes, not reads.** Codex's read-only sandbox forbids
  writing anywhere; it does not confine reading to the worktree, and on every
  platform it can read any file your account can. The plugin closes the route a
  pull request controls — `core.symlinks=false` means a link committed in the
  diff is checked out as text naming its target rather than as a path anything
  can follow — but a reviewer that has been argued into looking somewhere else
  can still read your files and quote them into its output. What limits the
  damage is that the review goes to a `0600` file in your cache and the plugin
  has no way to publish it: nothing leaves the machine unless you send it. Read
  a review before you paste it. Confining reads properly needs Codex's
  permission profiles, which are in beta as of Codex 0.138.
- **The in-flight cleanup race.** A `clean` that took its snapshot before a
  review recorded itself cannot hold back a marker that does not exist yet. The
  guard is not a lock, and a lock that outlives a crashed run is a worse failure.
- **The manifest lock expires**, by design, for the same reason. A holder that
  overruns that window can in principle be preempted between checking that the
  lock is still its own and releasing it; closing that properly means a lock
  manager, which is more machinery than this warrants.
- **Codex's findings are advisory** and some are wrong. The plugin does not
  publish them anywhere, and deliberately has no way to.

## Out of scope

- Vulnerabilities in the Codex CLI, the GitHub CLI, `git`, or Node — report
  those upstream. Something this plugin does that turns a safe upstream
  behaviour into an unsafe one is in scope.
- A user deciding to run something the plugin warned them about.
- Findings that require an attacker who already has code execution as your user.
