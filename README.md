# dsh-gitbash

DSH profile plugin: makes the model-facing **`bash` tool work on Windows via
[Git for Windows](https://gitforwindows.org/) (Git Bash).

The shipped DSH composition disables the bash tool on win32 (`!!js process.platform === 'win32'`
in `dsh-base` and the agent presets), leaving only the `pwsh` tool. This
bundle re-adds the bash tool for Windows by mounting a sibling executor
service (`ctx.gitbash`) that runs Git Bash — it does **not** displace
`ctx.shell`, so the `pwsh` tool keeps working unchanged.

## What you get

- A model-facing tool literally named `bash`, with the same contract as the
  POSIX bash tool: `bash -c` execution, terminal-card presentation, `[exit
  code: N]` markers, `run_in_background` jobs, and the same environment
  overrides (`TERM=dumb`, `PAGER=cat`, …).
- Automatic Git Bash discovery, in preference order:
  1. `bashPath` config / settings value (pinned),
  2. well-known installs — each root's `bin\bash.exe` then `usr\bin\bash.exe`:
     `C:\Program Files\Git`, `C:\Program Files (x86)\Git`,
     `%LOCALAPPDATA%\Programs\Git`, `~/scoop/apps/git/current` (Scoop),
  3. Git-owned PATH entries.
  When nothing is found, the error lists every probed candidate path.
- The Git runtime dirs (`bin`, `usr\bin`, `mingw64\bin`) are prepended to
  each child's PATH, so `grep`, `sed`, `git`, … resolve inside bash.
- MSYS path compatibility: `workdir` values in Git Bash style (`/d/foo`,
  `~/foo`) are converted to Windows paths automatically, and a workdir that
  does not exist fails with a clear error instead of a cryptic spawn ENOENT.
  A pinned `bashPath` is validated the same way (and may itself be given in
  MSYS form).
- A coherent shell environment: children get `SHELL` (the resolved
  `bash.exe`) and `HOME` (from `USERPROFILE` when unset), so scripts and
  tools that read them behave like a normal Git Bash terminal. Caller-supplied
  env entries always win.
- Background jobs distinguish *never started* from *terminated*: a spawn
  failure settles the job as `failed` with the underlying error, instead of
  being reported as `killed`.

## ⚠️ No file sandbox (important tradeoff)

The `pwsh` tool runs under DSH's windows-acl sandbox (restricted token +
workspace/temp write grants). **Git Bash cannot run under that sandbox**: the
msys2 runtime fails to create its signal pipe under a WRITE_RESTRICTED token
(`*** fatal error - couldn't create signal pipe, Win32 error 5`, exit
`0xC0000142`) — verified against `bin/bash.exe`, `usr/bin/bash.exe`, and
with `MSYS` environment tweaks, while pwsh runs fine under the same sandbox.

So this executor is **unconfined** (`sandboxMode` is `undefined`): bash
commands run with the harness process's full file access, exactly like a
normal Git Bash terminal. The tool description states this explicitly, and
the sandbox-escalation parameters are not advertised for it. If you need a
file-sandboxed shell on Windows, keep using the `pwsh` tool.

## Install

```sh
# requires pnpm on PATH
# from a local checkout (live-linked; edits take effect without re-installing):
dsh plugin --profile web add link:./dsh-gitbash
# from a copy (self-contained; re-run `add` after editing sources):
# dsh plugin --profile web add file:./dsh-gitbash
# from GitHub:
# dsh plugin --profile web add https://github.com/GrounzerLiu/dsh-gitbash.git
```

> The bundle imports `@deepseek-ai/*` packages and declares them in
> `dependencies` pinned to the harness versions it was built against, so a
> checkout resolves on its own (`pnpm install`) and on CI. At runtime the
> harness's own copies always win: `link:` installs resolve through the
> profile's `node_modules`, and `file:`/GitHub installs are hoisted into it.

Then **restart the dsh web process** (bundle layers are read at boot) and
reload the browser page.

### Development loop

For `link:` installs the profile's `node_modules/dsh-gitbash` is a symlink to
the checkout. The checkout itself needs its dependencies resolvable: create a
junction from the checkout's `node_modules` to the profile fallback directory
(`$DSH_HOME/profiles/node_modules`, which links every `@deepseek-ai/*`
package of the installation), or run `pnpm install` inside the checkout.
After editing sources, only the dsh web restart is needed — no re-install.

## Tests

```sh
node --test   # pure-function tests + mock-subprocess executor tests + real-spawn smoke tests (smoke tests skip when no Git Bash detected)
```

The executor's resolve/spawn/run/start paths are exercised with a mocked
`subprocess` service, so they run on any platform; only the two real-spawn
smoke tests require a Git Bash installation (win32).

## What the patch does

`patch.yml` inserts two host-plane rows, both inert on POSIX:

| row id | module | purpose |
| --- | --- | --- |
| `gitbash-executor` | `dsh-gitbash` (`lib/executor.js`) | registers the `ctx.gitbash` service |
| `tool-gitbash` | `dsh-gitbash/tool` (`lib/tool.js`) | registers the `bash` tool |

## Uninstall

```sh
dsh plugin --profile web remove dsh-gitbash
# then restart dsh web
```

## Config

The executor registers a `gitbash` settings section, so `$DSH_HOME/settings.yaml`
can tune it without touching the profile patch:

```yaml
gitbash:
  bashPath: 'C:\Program Files\Git\bin\bash.exe'   # optional pin
  timeoutMs: 120000
```

`gitbash-executor` row `config` (all optional; the settings section overrides):

| key | default | meaning |
| --- | --- | --- |
| `bashPath` | auto-detected | absolute path to Git Bash's `bash.exe` |
| `cwd` | `process.cwd()` | default working directory |
| `timeoutMs` | `120000` | default per-command timeout |
| `maxTimeoutMs` | `600000` | cap the model may not exceed |
| `maxOutputBytes` | `65536` | in-memory per-stream cap (spill file beyond) |
| `maxSpillBytes` | `64 MiB` | spill-file cap |
| `graceMs` | `3000` | SIGTERM→SIGKILL grace |

`tool-gitbash` row `config`:

| key | default | meaning |
| --- | --- | --- |
| `enableRunInBackground` | `true` | expose `run_in_background` |

## Notes

- The tool is named `bash` on purpose: the agent instructions and prompt
  sections already speak bash; on win32 no other `bash` tool is mounted, so
  there is no name collision. A future preset that enables the shipped
  `tool-bash` on win32 would collide — don't mount both.
- `where bash` on Windows often resolves WSL's `bash.exe`
  (`C:\Windows\System32\bash.exe`). This plugin never spawns a bare `bash`:
  it always uses the detected/pinned Git Bash path.
- The persistent PTY terminal feature (`ctx.terminals`) is preset-plane and
  out of scope for this bundle.
- Other profiles work unchanged: the rows are host-plane and win32-gated, so
  the same plugin also serves `--profile headless`
  (`dsh plugin --profile headless add link:./dsh-gitbash`).
