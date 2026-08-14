/**
 * Git Bash executor for DSH on Windows.
 *
 * Registers as `ctx.gitbash` — a sibling of the `ctx.shell` capability seam
 * (which stays owned by the platform shell: pwsh on win32). Commands run as
 * `bash -c <command>` through Git for Windows' `bash.exe`, located
 * automatically (well-known install roots, then Git-owned PATH entries) or
 * pinned with the `bashPath` config.
 *
 * SANDBOXING: this executor does NOT confine commands. The windows-acl
 * restricted-token sandbox breaks the msys2 runtime of every Git Bash
 * binary (`*** fatal error - couldn't create signal pipe, Win32 error 5`,
 * exit 0xC0000142) — verified against `bin/bash.exe`, `usr/bin/bash.exe`,
 * and with MSYS environment tweaks, while pwsh runs fine under the same
 * sandbox. So `sandboxMode` is `undefined` and commands run with the file
 * access of the harness process (like a normal Git Bash terminal). The tool
 * therefore does not advertise sandbox escalation.
 *
 * The module's default export is the Service class itself, so the profile
 * patch mounts it as a plain plugin row.
 *
 * @module dsh-gitbash/executor
 */
import { Service } from "@deepseek-ai/cordis";
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** The service name this executor registers under. */
const SERVICE_NAME = "gitbash";
/** Settings namespace of this executor (distinct from the shared `shell` namespace, so the
 *  pwsh executor's settings section is untouched). */
const SETTINGS_NAMESPACE = settingsNamespace("gitbash");

/** Model-friendly environment overrides (the same set the shipped executors apply). */
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

	/** The currently authoritative config: the settings section, or the composition entry. */
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
		assertServiceableConfig(config);
		this.source = () => config;
		installSettingsSection(ctx, SETTINGS_NAMESPACE, GitBashExecutor.Config, config, {
			validate: assertServiceableConfig,
			setSource: (current) => {
				this.source = current;
			},
			onChange: () => {
				// A settings change may repoint bashPath: drop the resolved cache.
				this.resolvedBashPathValue = void 0;
				this.resolvedPathEntriesValue = void 0;
			}
		});
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
			stdoutMaxBytes,
			...(request.signal !== void 0 ? { signal: request.signal } : {}),
			...(request.stdin !== void 0 ? { stdin: request.stdin } : {}),
			...(request.env !== void 0 ? { env: request.env } : {}),
			...(request.dshEnv !== void 0 ? { dshEnv: request.dshEnv } : {})
		};
	}

	/** Run a command in the foreground. */
	async run(spec) {
		return this.runArgv(spec, [this.bashPath, "-c", spec.command]);
	}

	/** Start a background process and return its handle immediately. */
	start(spec) {
		return this.startArgv(spec, [this.bashPath, "-c", spec.command]);
	}

	/** Map a resolved spec and explicit argv onto a fully-specified subprocess spawn. */
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

	/** Run an explicit argv with the foreground lifecycle and cause classification. */
	async runArgv(spec, argv) {
		const d = deadline(spec.signal, spec.timeoutMs, "BASH_TIMEOUT");
		try {
			const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal));
			const outcome = await handle.done;
			const collected = GitBashExecutor.collected(handle);
			const timedOut = timeoutOf(d.signal, "BASH_TIMEOUT") !== void 0;
			const aborted = d.signal.aborted && !timedOut;
			return {
				...outcome,
				timedOut,
				aborted,
				timeoutMs: spec.timeoutMs,
				stdout: finalOutput(collected.stdout),
				stderr: finalOutput(collected.stderr)
			};
		} finally {
			d[Symbol.dispose]();
		}
	}

	/** Start an explicit argv with the background lifecycle and process-handle shape. */
	startArgv(spec, argv) {
		const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal));
		const collected = GitBashExecutor.collected(running);
		let spawnFailureNote;
		const consumeSpawnFailure = () => {
			const note = spawnFailureNote ?? "";
			spawnFailureNote = void 0;
			return note;
		};
		let stdoutOffset = 0;
		let stderrOffset = 0;
		const proc = {
			status: "running",
			exitCode: null,
			signal: null,
			spawnError: void 0,
			done: running.done.then((outcome) => {
				if (proc.status === "running") proc.status = spec.signal?.aborted === true || outcome.signal !== null ? "killed" : "completed";
				proc.exitCode = outcome.exitCode;
				proc.signal = outcome.signal;
			}, (error) => {
				// A spawn failure is not a kill: report it as its own status so
				// job consumers can distinguish "never started" from "terminated".
				proc.status = "failed";
				proc.spawnError = `spawn failed: ${String(error)}`;
				spawnFailureNote = proc.spawnError;
			}),
			readOutput: () => {
				const out = collected.stdout.readFrom(stdoutOffset);
				const err = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = out.nextOffset;
				stderrOffset = err.nextOffset;
				const errText = err.text.length > 0 ? err.text : consumeSpawnFailure();
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
				running.terminate();
				return true;
			}
		};
		return proc;
	}
}

export { GitBashExecutor, GitBashExecutor as default, findGitBash, gitBashCandidates, gitPathEntries, msysToWindows };
