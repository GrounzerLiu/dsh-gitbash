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
  code: N]` markers, `run_in_background` jobs, promotion on timeout, and the
  same environment overrides (`TERM=dumb`, `PAGER=cat`, …).
- **Background jobs deliver output.** The job spec declares non-consuming pull
  sources over the process's stdout/stderr, which the `ctx.jobs` registry
  pumps into its per-job ring; `job_output` reads that ring. This mirrors the
  shipped `@deepseek-ai/dsh-tool-bash` exactly — see the note on the
  zero-output bug below.
- **Promotion on timeout** (`promoteOnTimeout`, default `true`): a foreground
  command that outlives its `timeoutMs` is *not* killed. The call stops
  waiting and returns the job id, and the command keeps running in the
  background:
  ```
  [still running after 120000ms; moved to background job bash-3]
  The command keeps running in the background. You will be notified when it finishes;
  read newer output with job_output, stop it with job_kill.
  ```
  Set `promoteOnTimeout: false` for the old kill-on-expiry behavior.
- Automatic Git Bash discovery, in preference order:
  1. `bashPath` config value (pinned),
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

## Relationship to the shipped tool (read this before editing)

`lib/tool.js` and `lib/executor.js` are **ports** of the shipped
`@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-bash-local` from DSH
`0.1.7-rc.2`, not independent implementations. Only two axes differ:

1. the service is `ctx.gitbash` instead of `ctx.shell` (on win32 `ctx.shell`
   belongs to pwsh, and the shipped POSIX bash pair is disabled);
2. the backend spawns Git for Windows' `bash.exe` instead of `bash` on PATH,
   which is where the Windows-specific discovery/PATH/workdir logic lives.

`GitBashExecutor` deliberately extends `Service` directly rather than
`ShellExecutor`: that base class hardcodes `super(ctx, "shell")`, so extending
it would collide with the pwsh executor instead of registering a sibling.

When the shipped tool changes, **diff against it**; do not re-derive the
implementation. Two drift incidents came from hand-maintaining a copy:

- **`owner` type.** The registry resolves `spec.owner` through
  `agents.get(session)`, i.e. a session **id** string. Passing the `Agent`
  object made every `run_in_background` call throw
  `session "[object Object]" has no live agent`.
- **Output pull sources.** `spec.output` replaced the old `readOutput()` job
  hook. Keeping the hook meant the registry had nothing to pump, so background
  jobs finished with the correct exit code but read as **permanently empty**.

Both are covered by `test/integration.test.mjs`, which runs against the real
`dsh-jobs-local` registry rather than a stub.

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
> `peerDependencies`/`devDependencies`. `devDependencies` pin the exact harness
> version the tests run against; `peerDependencies` use the RANGE
> `>=0.1.7-rc.2 <0.3.0-0` rather than an exact pin.
>
> **Why a range, not an exact pin.** The harness skips any bundle whose
> `@deepseek-ai/dsh-*` peers do not admit the running runtime — the plugin
> simply does not load, and its tools silently disappear. An exact pin turns
> every runtime release into an outage: when the Desktop app auto-updated from
> `0.1.7-rc.2` to `0.2.0-rc.1`, this bundle was skipped and the `bash` tool
> vanished. The seam contracts had not changed at all (verified: every file of
> `dsh-shell`, `dsh-jobs`, and `dsh-tools` is byte-identical across those two
> versions, and all 43 tests pass against `0.2.0-rc.1`), so the block was
> purely the version string.
>
> The upper bound stays `<0.3.0-0` so a genuinely breaking runtime line still
> fails closed instead of loading into an unknown contract. When a real break
> happens, re-port from the shipped tool as described above rather than
> widening the range.
>
> A `link:` install resolves `@deepseek-ai/*` from the checkout's own
> `node_modules`, which is why they must be installed there rather than
> assumed from the host. The host's copies are separate module instances; the
> service objects you pass in come from the host either way, so the two only
> need to agree on shapes.

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
node --test
```

Three layers:

- **pure functions** — Git Bash discovery, MSYS path conversion, PATH entries.
- **executor + tool against mock services** — the `resolve`/`execute`/
  `result`/`observed` lifecycle, deadline classification, kill semantics,
  the job registration shape, and the promotion path.
- **integration against the real runtime** (`test/integration.test.mjs`) —
  boots a real Cordis context with `dsh-jobs-local`, `dsh-subprocess-local`,
  and `dsh-tool-jobs`, then asserts that a background job's stdout/stderr
  actually land in the registry ring and that an `Agent`-typed owner is
  rejected. This is the layer that catches drift in the seam contract; the
  mock layer alone cannot.

Everything except the real-spawn tests runs on any platform. Tests that need
a Git Bash installation skip themselves when none is detected.

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

All executor config lives in the `gitbash-executor` row of `patch.yml`
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`), not in
`$DSH_HOME/settings.yaml`: DSH 0.1.7 reworked the settings API
(`ctx.settings.installSection` is gone), so this bundle declares its `Config`
schema and lets the host project the form.

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
| `promoteOnTimeout` | `true` | on `timeoutMs` expiry, move the command to the background as a job instead of killing it |

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
