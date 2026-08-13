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
- Automatic Git Bash discovery: `C:\Program Files\Git\bin\bash.exe`,
  `C:\Program Files (x86)\Git\bin\bash.exe`,
  `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, then Git-owned PATH entries.
  Pin it with `bashPath` in the `gitbash-executor` row config if needed.
- The Git runtime dirs (`bin`, `usr\bin`, `mingw64\bin`) are prepended to
  each child's PATH, so `grep`, `sed`, `git`, … resolve inside bash.

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
dsh plugin --profile web add file:./dsh-gitbash    # from the plugin's parent dir
# or from the registry once published:
# dsh plugin --profile web add dsh-gitbash
```

Then **restart the dsh web process** (bundle layers are read at boot) and
reload the browser page. After editing the plugin sources, re-run the `add`
(or `dsh plugin --profile web remove dsh-gitbash` + `add`) to refresh the
installed copy, then restart again.

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

`gitbash-executor` row `config` (all optional):

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
