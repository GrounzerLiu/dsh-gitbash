/**
 * Git Bash executor for DSH on Windows.
 *
 * A copy of the shipped `@deepseek-ai/dsh-bash-local` executor — same seam
 * contract, same lifecycle, same output/observed plumbing — with the shell
 * backend swapped from POSIX `bash` on PATH to Git for Windows' `bash.exe`,
 * and the service name changed from `shell` to `gitbash`.
 *
 * WHY A SEPARATE SERVICE: on win32 the shipped composition mounts
 * `@deepseek-ai/dsh-pwsh-sandbox` as the `ctx.shell` seam and disables the
 * POSIX bash pair by design, so the `pwsh` tool keeps working unchanged. This
 * executor therefore registers a SIBLING service (`ctx.gitbash`) instead of
 * competing for `ctx.shell`; the model-facing `bash` tool reaches it through
 * `dsh-gitbash/tool`.
 *
 * NOT A SANDBOXED EXECUTOR: the windows-acl restricted-token sandbox breaks
 * the msys2 runtime of every Git Bash binary (`*** fatal error - couldn't
 * create signal pipe, Win32 error 5`, exit 0xC0000142) — verified against
 * `bin/bash.exe`, `usr/bin/bash.exe`, and with MSYS environment tweaks, while
 * pwsh runs fine under the same sandbox. So `sandboxMode` is `undefined` and
 * commands run with the file access of the harness process, exactly like a
 * normal Git Bash terminal. The tool layer consequently advertises no
 * sandbox-escalation parameters.
 *
 * Windows-specific behavior this copy adds over `bash-local`:
 * - Git Bash discovery (config `bashPath`, well-known install roots, then
 *   Git-owned PATH entries) with a clear missing-dependency error.
 * - The Git runtime dirs (`bin`, `usr\bin`, `mingw64\bin`) prepended to each
 *   child's PATH so `grep`, `sed`, `git`, … resolve inside bash.
 * - MSYS path compatibility for `workdir` (`/d/foo`, `~/foo` → Windows) and
 *   an existence check, so a bad workdir fails clearly instead of as a
 *   cryptic spawn ENOENT.
 * - A coherent child shell environment (`SHELL`, `HOME`).
 *
 * @module dsh-gitbash/executor
 */
import { Service } from "@deepseek-ai/cordis";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** The service name this executor registers under (a sibling of `ctx.shell`, never a replacement). */
const SERVICE_NAME = "gitbash";

/** Model-friendly environment overrides: disable colors, pagers, and interactive terminal
 *  features that would garble tool output (the same set the shipped executors apply). */
const ENV_OVERRIDES = {
	NO_COLOR: "1",
	TERM: "dumb",
	PAGER: "cat",
	GIT_PAGER: "cat"
};

/** Default SIGTERM→SIGKILL grace period (matches the shipped executors). */
const DEFAULT_GRACE_MS = 3e3;
/** Default per-stream spill cap (matches the shipped executors). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader) {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...(read.spillPath !== void 0 ? { spillPath: read.spillPath } : {})
	};
}

function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`gitbash: ${name} must be a positive finite number`);
}

/** Reject config this executor could not run with (mirrors bash-local's checks). */
function assertServiceableConfig(config) {
	assertPositiveFinite("timeoutMs", config.timeoutMs);
	assertPositiveFinite("maxTimeoutMs", config.maxTimeoutMs);
	assertPositiveFinite("maxOutputBytes", config.maxOutputBytes);
	assertPositiveFinite("maxSpillBytes", config.maxSpillBytes);
	assertPositiveFinite("graceMs", config.graceMs);
	if (config.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`gitbash: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
}

/**
 * Well-known Git for Windows install roots, probed in order: Program Files
 * (64-bit, 32-bit), `%LOCALAPPDATA%\Programs` (per-user installs), and Scoop
 * (`~/scoop/apps/git/current`).
 */
function gitInstallRoots(env = process.env) {
	const roots = [];
	if (env.ProgramFiles !== void 0) roots.push(join(env.ProgramFiles, "Git"));
	if (env["ProgramFiles(x86)"] !== void 0) roots.push(join(env["ProgramFiles(x86)"], "Git"));
	if (env.LOCALAPPDATA !== void 0) roots.push(join(env.LOCALAPPDATA, "Programs", "Git"));
	if (env.USERPROFILE !== void 0) roots.push(join(env.USERPROFILE, "scoop", "apps", "git", "current"));
	return roots;
}

/**
 * Candidate bash executables, in preference order: each install root's
 * `bin\bash.exe` (the environment-initializing shim) then `usr\bin\bash.exe`
 * (the raw msys2 runtime), so a broken or absent shim still finds a usable
 * shell.
 */
function gitBashCandidates(env = process.env) {
	return gitInstallRoots(env).flatMap((root) => [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]);
}

/**
 * Convert a model-friendly MSYS-style path to a Windows path: `/d/foo`
 * → `D:\foo`, `/d` → `D:\`, `~/foo` → `%USERPROFILE%\foo`. Everything else
 * (relative paths, `C:\…`, `C:/…`) passes through unchanged. The model often
 * copies absolute paths straight out of bash's `pwd` (e.g. `/d/dsh-plugins`),
 * which `path.isAbsolute` accepts on Windows but `spawn` cannot use as-is.
 */
function msysToWindows(p, env = process.env) {
	if (typeof p !== "string" || p.length === 0) return p;
	if (p === "~") return env.USERPROFILE ?? p;
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return env.USERPROFILE === void 0 ? p : env.USERPROFILE + p.slice(1).replace(/\//g, "\\");
	}
	const drive = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
	if (drive !== null) {
		const rest = drive[2] === void 0 ? "" : drive[2];
		return `${drive[1].toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
	}
	return p;
}

/** Give a clear error when a resolved working directory cannot be used as a spawn cwd. */
function assertWorkdirExists(workdir) {
	let exists = false;
	try {
		exists = existsSync(workdir);
	} catch {
		exists = false;
	}
	if (!exists) throw new Error(`gitbash: workdir does not exist: ${workdir}`);
}

/**
 * Resolve the bash executable: an explicit `bashPath` config wins (converted
 * from MSYS form and existence-checked, so a typo fails loudly at first use
 * instead of as a cryptic spawn ENOENT); otherwise the first existing
 * well-known Git for Windows install; otherwise a PATH entry that looks
 * Git-owned; otherwise `undefined` (reported as a clear missing-dependency
 * error at first use, so boot never fails on its own).
 */
function findGitBash(configured, env = process.env) {
	if (configured !== void 0 && configured.length > 0) {
		const pinned = msysToWindows(configured, env);
		if (!existsSync(pinned)) throw new Error(`gitbash: configured bashPath does not exist: ${configured}`);
		return pinned;
	}
	for (const candidate of gitBashCandidates(env)) {
		if (existsSync(candidate)) return candidate;
	}
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "bash.exe");
		if (existsSync(candidate) && /git/i.test(dir)) return candidate;
	}
	return void 0;
}

/** Git runtime dirs to prepend to the child PATH so coreutils resolve inside bash. */
function gitPathEntries(bashPath) {
	const root = dirname(dirname(bashPath));
	return [join(root, "bin"), join(root, "usr", "bin"), join(root, "mingw64", "bin")].filter((dir) => existsSync(dir));
}

/**
 * Git Bash execution service: the `ctx.gitbash` implementation.
 *
 * The handle shape, deadline classification, output/observed readers, and
 * kill semantics are the shipped `ShellProcess` / `ShellExecution` contract,
 * so the model-facing tool in `lib/tool.js` is a direct port of
 * `@deepseek-ai/dsh-tool-bash` and stays aligned with it.
 */
class GitBashExecutor extends Service {
	static inject = ["subprocess"];

	/** Runtime configuration schema (composition row `config`). */
	static Config = z.object({
		bashPath: z.string(),
		cwd: z.string(),
		timeoutMs: z.number().default(12e4),
		maxTimeoutMs: z.number().default(6e5),
		maxOutputBytes: z.number().default(64e3),
		maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
		graceMs: z.number().default(DEFAULT_GRACE_MS)
	});

	/** The authoritative config: the composition row's `config`, as schemastery resolved it. */
	source;
	/** Lazily-resolved bash executable and Git runtime dirs. Plain fields on purpose: cordis
	 *  exposes services to child contexts through `Object.create(this)` copies, on which
	 *  ECMAScript private fields are unreadable. */
	resolvedBashPathValue;
	resolvedPathEntriesValue;

	/** Validated config (schemastery applied the defaults before construction). */
	get config() {
		return this.source();
	}

	constructor(ctx, config) {
		super(ctx, SERVICE_NAME);
		const entry = config;
		assertServiceableConfig(entry);
		this.source = () => entry;
	}

	/** This executor cannot confine commands (see module doc): the tool layer sees no sandboxing. */
	get sandboxMode() {
		return void 0;
	}

	/** The bash executable every command runs through (resolved lazily, cached). */
	get bashPath() {
		if (this.resolvedBashPathValue === void 0) {
			const found = findGitBash(this.config.bashPath);
			if (found === void 0) {
				throw new Error(
					`gitbash: Git Bash not found. Probed: ${gitBashCandidates().join("; ")}. Install Git for Windows, or set bashPath in the gitbash-executor row config or the gitbash settings section (e.g. bashPath: 'C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe').`
				);
			}
			this.resolvedBashPathValue = found;
			this.resolvedPathEntriesValue = gitPathEntries(found);
		}
		return this.resolvedBashPathValue;
	}

	/** Git runtime dirs prepended to every child's PATH (empty when unresolvable). */
	get pathEntries() {
		if (this.resolvedPathEntriesValue === void 0) {
			// Prefer the cache populated by the `bashPath` getter; fall back to a
			// lenient independent resolution so callers never see the missing-bash error.
			if (this.resolvedBashPathValue !== void 0) {
				this.resolvedPathEntriesValue = gitPathEntries(this.resolvedBashPathValue);
			} else {
				try {
					const found = findGitBash(this.config.bashPath);
					this.resolvedPathEntriesValue = found === void 0 ? [] : gitPathEntries(found);
				} catch {
					this.resolvedPathEntriesValue = [];
				}
			}
		}
		return this.resolvedPathEntriesValue;
	}

	/**
	 * Resolve a request into a fully-specified spec: fill `workdir` and
	 * `timeoutMs` from config, cap `timeoutMs`, and normalize the workdir to
	 * a Windows path that exists (clear errors instead of cryptic spawn
	 * failures).
	 */
	resolve(request) {
		const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, "gitbash: request.timeoutMs");
		const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes;
		assertPositiveFinite("request.stdoutMaxBytes", stdoutMaxBytes);
		const workdir = msysToWindows(request.workdir ?? this.config.cwd ?? process.cwd());
		assertWorkdirExists(workdir);
		return {
			command: request.command,
			workdir,
			timeoutMs,
			onExpiry: request.onExpiry ?? "kill",
			stdoutMaxBytes,
			...(request.signal !== void 0 ? { signal: request.signal } : {}),
			...(request.stdin !== void 0 ? { stdin: request.stdin } : {}),
			...(request.env !== void 0 ? { env: request.env } : {}),
			...(request.dshEnv !== void 0 ? { dshEnv: request.dshEnv } : {}),
			sandboxPolicy: request.sandboxPolicy
		};
	}

	/** Map one resolved spec and explicit argv onto a fully-specified subprocess spawn. */
	spawnSpec(spec, argv, stdoutMaxBytes, signal) {
		const collect = (maxBytes) => ({
			maxBytes,
			spill: { maxBytes: this.config.maxSpillBytes }
		});
		const env = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv };
		const entries = this.pathEntries;
		if (entries.length > 0) env.PATH = [...entries, env.PATH ?? process.env.PATH ?? ""].join(delimiter);
		// Give children a coherent shell environment: some tools read $SHELL, and
		// Git Bash misbehaves without a $HOME (falls back to `/`). A caller's own
		// explicit entries always win.
		if (env.SHELL === void 0) env.SHELL = this.bashPath;
		if (env.HOME === void 0) {
			const home = env.USERPROFILE ?? process.env.USERPROFILE;
			if (home !== void 0) env.HOME = home;
		}
		return {
			argv,
			cwd: spec.workdir,
			stdio: {
				stdin: spec.stdin !== void 0 ? { data: spec.stdin } : "ignore",
				stdout: collect(stdoutMaxBytes),
				stderr: collect(this.config.maxOutputBytes)
			},
			graceMs: this.config.graceMs,
			signal,
			env
		};
	}

	/** The collect-mode readers the executor itself requested (present by construction). */
	static collected(handle) {
		const { stdout, stderr } = handle.collected;
		if (stdout === void 0 || stderr === void 0) throw new Error("gitbash: subprocess implementation dropped a requested collect stream");
		return { stdout, stderr };
	}

	/**
	 * Execute the public command as `bash -c` in a provider-managed range.
	 * @param spec - a resolved spec from {@link resolve}, never a raw request.
	 * @returns the live execution handle (process plus foreground `result()`).
	 */
	async execute(spec) {
		return this.executeArgv(spec, [this.bashPath, "-c", spec.command]);
	}

	/**
	 * Execute an explicit argv with the lifecycle, environment, output,
	 * deadline, and cancellation semantics of this executor — ported from the
	 * shipped `LocalBashExecutor.executeArgv` so the handle contract matches
	 * `ShellProcess` / `ShellExecution` exactly.
	 * @param spec - resolved execution settings.
	 * @param argv - exact argv (the public command's shell argv, or a subclass's).
	 * @returns the live execution handle; a spawn rejection settles the handle
	 *   as killed while `result()` carries the same failure as its rejection.
	 */
	async executeArgv(spec, argv) {
		let spawnSignal;
		let classify;
		let disarm = () => {};
		if (spec.onExpiry === "kill") {
			const d = deadline(spec.signal, spec.timeoutMs, "BASH_TIMEOUT");
			spawnSignal = d.signal;
			classify = () => {
				const timedOut = timeoutOf(d.signal, "BASH_TIMEOUT") !== void 0;
				return {
					timedOut,
					aborted: d.signal.aborted && !timedOut
				};
			};
			disarm = () => {
				d[Symbol.dispose]();
			};
		} else {
			spawnSignal = spec.signal;
			classify = () => ({
				timedOut: false,
				aborted: spec.signal?.aborted === true
			});
		}
		let running;
		let syncSpawnError;
		try {
			running = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, spawnSignal));
		} catch (error) {
			syncSpawnError = { error };
		}
		const emptyReader = {
			readFrom: () => ({
				text: "",
				lossy: false,
				nextOffset: 0
			})
		};
		const collected = running !== void 0
			? GitBashExecutor.collected(running)
			: { stdout: emptyReader, stderr: emptyReader };
		const spawned = running !== void 0 ? running.done : Promise.reject(syncSpawnError.error);
		let providerFailure;
		let providerFailureReported = false;
		/** Consume the provider-failure note once, for the consuming read path. */
		const consumeProviderFailure = () => {
			if (providerFailure === void 0 || providerFailureReported) return "";
			providerFailureReported = true;
			return providerFailure.note;
		};
		/** The non-consuming stderr reader: the provider note substitutes for the empty stream. */
		const observedStderr = {
			readFrom: (fromByte) => {
				if (providerFailure === void 0) return collected.stderr.readFrom(fromByte);
				const note = Buffer.from(providerFailure.note, "utf8");
				return {
					text: note.subarray(Math.min(fromByte, note.length)).toString("utf8"),
					nextOffset: note.length,
					lossy: false
				};
			}
		};
		let stdoutOffset = 0;
		let stderrOffset = 0;
		let resultPromise;
		const proc = {
			status: "running",
			exitCode: null,
			signal: null,
			observed: {
				stdout: collected.stdout,
				stderr: observedStderr
			},
			done: spawned.then(
				(outcome) => {
					if (proc.status === "running") {
						proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? "killed" : "completed";
					}
					proc.exitCode = outcome.exitCode;
					proc.signal = outcome.signal;
					disarm();
				},
				(error) => {
					proc.status = "killed";
					let detail = "unprintable provider failure";
					try {
						detail = String(error);
					} catch {}
					providerFailure = {
						error,
						note: `subprocess failed before reporting an outcome: ${detail}`
					};
					disarm();
				}
			),
			readOutput: () => {
				const out = collected.stdout.readFrom(stdoutOffset);
				const err = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = out.nextOffset;
				stderrOffset = err.nextOffset;
				const failure = consumeProviderFailure();
				const failureSeparator = err.text.length > 0 && !err.text.endsWith("\n") ? "\n" : "";
				const errText = err.text + (failure.length > 0 ? `${failureSeparator}${failure}` : "");
				const separator = out.text.length > 0 && !out.text.endsWith("\n") ? "\n" : "";
				return {
					delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
					lossy: out.lossy || err.lossy,
					...(out.spillPath !== void 0 ? { stdoutSpillPath: out.spillPath } : {}),
					...(err.spillPath !== void 0 ? { stderrSpillPath: err.spillPath } : {})
				};
			},
			kill: () => {
				if (proc.status !== "running") return false;
				proc.status = "killed";
				running?.terminate();
				return true;
			},
			result: () => {
				resultPromise ??= proc.done.then(() => {
					if (providerFailure !== void 0) throw providerFailure.error;
					return {
						exitCode: proc.exitCode,
						signal: proc.signal,
						...classify(),
						timeoutMs: spec.timeoutMs,
						stdout: finalOutput(collected.stdout),
						stderr: finalOutput(collected.stderr)
					};
				});
				return resultPromise;
			}
		};
		return proc;
	}
}

export {
	ENV_OVERRIDES,
	GitBashExecutor,
	GitBashExecutor as default,
	assertServiceableConfig,
	findGitBash,
	gitBashCandidates,
	gitPathEntries,
	msysToWindows
};
