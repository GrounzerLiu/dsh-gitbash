/**
 * Tests for dsh-gitbash.
 *
 * Pure functions (`findGitBash`, `gitBashCandidates`, `gitPathEntries`,
 * `msysToWindows`) are tested against throwaway directory trees. The
 * executor's resolve/spawn/execute lifecycle is exercised with a mock
 * `subprocess` service, so those tests run on any platform without a Git
 * Bash installation. The model-facing tool is mounted on a mock cordis
 * context to cover the job/background and promote-on-timeout paths.
 * The real-spawn smoke tests run only when a Git Bash installation is
 * actually detected (win32).
 *
 * Run: `node --test`
 *
 * @module dsh-gitbash/test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { TimeoutReason } from "@deepseek-ai/dsh-timeout";
import { GitBashExecutor, findGitBash, gitBashCandidates, gitPathEntries, msysToWindows } from "../lib/executor.js";
import * as tool from "../lib/tool.js";

/** Build a fake install root: `gitRoot/bin/bash.exe` and/or `gitRoot/usr/bin/bash.exe`. */
function fakeGitRoot(parent, { bin = true, usr = false } = {}) {
	const root = join(parent, "Git");
	if (bin) {
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "bash.exe"), "");
	}
	if (usr) {
		mkdirSync(join(root, "usr", "bin"), { recursive: true });
		writeFileSync(join(root, "usr", "bin", "bash.exe"), "");
	}
	return parent;
}

/** Convert a Windows path into its MSYS-style form (`C:\a\b` → `/c/a/b`). */
function toMsys(p) {
	const m = /^([a-zA-Z]):\\(.*)$/.exec(p);
	return m === null ? p : `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** A minimal cordis-like context: service registration + inject no-ops. */
function mockCtx(overrides = {}) {
	return {
		inject() {},
		reflect: { provide() {} },
		...overrides
	};
}

/** Construct an executor with a mock context and a full valid config. */
function makeExecutor(ctxOverrides = {}, configOverrides = {}) {
	return new GitBashExecutor(mockCtx(ctxOverrides), {
		timeoutMs: 12e4,
		maxTimeoutMs: 6e5,
		maxOutputBytes: 64e3,
		maxSpillBytes: 64 * 1024 * 1024,
		graceMs: 3e3,
		...configOverrides
	});
}

/** Run `fn` against a temp Git install root with a real (empty) bash.exe to pin. */
async function withGitRoot(fn) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const gitRoot = join(dir, "Git");
		mkdirSync(join(gitRoot, "bin"), { recursive: true });
		writeFileSync(join(gitRoot, "bin", "bash.exe"), "");
		return await fn(gitRoot);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A collect-mode reader stub that returns fixed text once. */
function fakeReader(text) {
	return { readFrom: () => ({ text, lossy: false, nextOffset: text.length }) };
}

/** A subprocess handle stub with settable outcome and terminate spy. */
function fakeHandle({ exitCode = 0, signal = null, stdout = "", stderr = "", done, terminate = () => {} } = {}) {
	return {
		done: done ?? Promise.resolve({ exitCode, signal }),
		collected: { stdout: fakeReader(stdout), stderr: fakeReader(stderr) },
		terminate
	};
}

test("module shapes", () => {
	assert.equal(typeof GitBashExecutor, "function");
	assert.deepEqual(GitBashExecutor.inject, ["subprocess"]);
	assert.ok(GitBashExecutor.Config, "executor exposes a Config schema");
	// The service name must stay a sibling of `ctx.shell`: on win32 pwsh owns
	// `ctx.shell`, and claiming it would displace the pwsh tool.
	assert.equal(tool.name, "tool-gitbash");
	assert.deepEqual(tool.inject, ["tools", "gitbash", "systemPrompt", "shellEnv"]);
	assert.equal(typeof tool.apply, "function");
	assert.ok(tool.Config, "tool exposes a Config schema");
});

test("gitBashCandidates covers well-known roots and both entry points", () => {
	const env = {
		ProgramFiles: "C:\\Program Files",
		"ProgramFiles(x86)": "C:\\Program Files (x86)",
		LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
		USERPROFILE: "C:\\Users\\me"
	};
	const candidates = gitBashCandidates(env);
	// Build expectations with the same `join` the implementation uses, so the
	// test is platform-neutral (win32 backslashes on Windows, POSIX separators
	// elsewhere) while still pinning the root/entry structure.
	assert.ok(candidates.includes(join("C:\\Program Files", "Git", "bin", "bash.exe")));
	assert.ok(candidates.includes(join("C:\\Program Files", "Git", "usr", "bin", "bash.exe")));
	assert.ok(candidates.includes(join("C:\\Program Files (x86)", "Git", "bin", "bash.exe")));
	assert.ok(candidates.includes(join("C:\\Users\\me\\AppData\\Local", "Programs", "Git", "bin", "bash.exe")));
	assert.ok(candidates.includes(join("C:\\Users\\me", "scoop", "apps", "git", "current", "bin", "bash.exe")));
});

test("msysToWindows: converts MSYS paths and passes everything else through", () => {
	const env = { USERPROFILE: "C:\\Users\\me" };
	assert.equal(msysToWindows("/d/dsh-plugins", env), "D:\\dsh-plugins");
	assert.equal(msysToWindows("/c/Program Files/Git", env), "C:\\Program Files\\Git");
	assert.equal(msysToWindows("/d", env), "D:\\");
	assert.equal(msysToWindows("/d/", env), "D:\\");
	assert.equal(msysToWindows("~/work", env), "C:\\Users\\me\\work");
	assert.equal(msysToWindows("~", env), "C:\\Users\\me");
	assert.equal(msysToWindows("D:\\keep\\me", env), "D:\\keep\\me");
	assert.equal(msysToWindows("C:/mixed/sep", env), "C:/mixed/sep");
	assert.equal(msysToWindows("relative/path", env), "relative/path");
	assert.equal(msysToWindows("", env), "");
	assert.equal(msysToWindows(void 0, env), void 0);
});

test("findGitBash: explicit bashPath wins and is converted/validated", () => {
	withGitRoot((gitRoot) => {
		const pinned = join(gitRoot, "bin", "bash.exe");
		assert.equal(findGitBash(pinned, {}), pinned);
		assert.equal(findGitBash(toMsys(pinned), {}), pinned);
	});
});

test("findGitBash: a configured bashPath that does not exist throws a clear error", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const missing = join(dir, "missing", "bash.exe");
		assert.throws(() => findGitBash(missing, {}), /bashPath does not exist/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findGitBash: well-known installs in preference order", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		// Program Files (x86) only -> found there
		const x86 = mkdtempSync(join(tmpdir(), "dsh-gitbash-x86-"));
		fakeGitRoot(x86);
		assert.equal(findGitBash(void 0, { ProgramFiles: join(dir, "empty"), "ProgramFiles(x86)": x86, LOCALAPPDATA: join(dir, "empty2") }), join(x86, "Git", "bin", "bash.exe"));
		// bin missing -> usr/bin fallback
		const usrRoot = mkdtempSync(join(tmpdir(), "dsh-gitbash-usr-"));
		fakeGitRoot(usrRoot, { bin: false, usr: true });
		assert.equal(findGitBash(void 0, { ProgramFiles: usrRoot }), join(usrRoot, "Git", "usr", "bin", "bash.exe"));
		// Scoop layout
		const scoopRoot = mkdtempSync(join(tmpdir(), "dsh-gitbash-scoop-"));
		const scoopGit = join(scoopRoot, "scoop", "apps", "git", "current");
		mkdirSync(join(scoopGit, "bin"), { recursive: true });
		writeFileSync(join(scoopGit, "bin", "bash.exe"), "");
		assert.equal(findGitBash(void 0, { USERPROFILE: scoopRoot }), join(scoopGit, "bin", "bash.exe"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findGitBash: Git-owned PATH entry", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const gitish = join(dir, "some", "git", "bin");
		mkdirSync(gitish, { recursive: true });
		writeFileSync(join(gitish, "bash.exe"), "");
		const result = findGitBash(void 0, { PATH: gitish });
		assert.equal(result, join(gitish, "bash.exe"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findGitBash: nothing found returns undefined", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const env = { ProgramFiles: join(dir, "pf"), "ProgramFiles(x86)": join(dir, "pf86"), LOCALAPPDATA: join(dir, "la"), USERPROFILE: join(dir, "up"), PATH: join(dir, "path") };
		assert.equal(findGitBash(void 0, env), void 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitPathEntries keeps only existing Git runtime dirs", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const gitRoot = join(dir, "Git");
		mkdirSync(join(gitRoot, "bin"), { recursive: true });
		mkdirSync(join(gitRoot, "usr", "bin"), { recursive: true });
		const entries = gitPathEntries(join(gitRoot, "bin", "bash.exe"));
		assert.ok(entries.includes(join(gitRoot, "bin")));
		assert.ok(entries.includes(join(gitRoot, "usr", "bin")));
		assert.ok(!entries.includes(join(gitRoot, "mingw64", "bin")), "missing dirs are excluded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolve: clamps timeoutMs to maxTimeoutMs and fills onExpiry", () => {
	const exec = makeExecutor();
	assert.equal(exec.resolve({ command: "echo hi", timeoutMs: 1e9 }).timeoutMs, 6e5);
	assert.equal(exec.resolve({ command: "echo hi", timeoutMs: 1000 }).timeoutMs, 1000);
	assert.equal(exec.resolve({ command: "echo hi" }).timeoutMs, 12e4);
	// Default expiry is 'kill'; the tool passes 'none' for background/promoted work.
	assert.equal(exec.resolve({ command: "echo hi" }).onExpiry, "kill");
	assert.equal(exec.resolve({ command: "echo hi", onExpiry: "none" }).onExpiry, "none");
});

test("resolve: converts an MSYS workdir to a Windows path", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const sub = join(dir, "sub");
		mkdirSync(sub, { recursive: true });
		const exec = makeExecutor();
		const spec = exec.resolve({ command: "echo hi", workdir: toMsys(sub) });
		assert.equal(spec.workdir.toLowerCase(), sub.toLowerCase());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolve: a nonexistent workdir throws a clear error", () => {
	const exec = makeExecutor();
	assert.throws(() => exec.resolve({ command: "x", workdir: join(tmpdir(), "dsh-gitbash-definitely-missing") }), /workdir does not exist/);
});

test("executor declares no sandbox mode (msys2 cannot run under the ACL sandbox)", () => {
	const exec = makeExecutor();
	assert.equal(exec.sandboxMode, void 0);
});

test("resolveWorkdir: ~ expands before relative-path resolution (win32)", { skip: process.platform !== "win32" }, () => {
	const exec = { agent: { session: { header: { cwd: "D:\\session\\workspace" } } } };
	const home = process.env.USERPROFILE;
	assert.equal(tool.resolveWorkdir("~", exec), home);
	assert.equal(tool.resolveWorkdir("~/sub", exec), join(home, "sub"));
	assert.equal(tool.resolveWorkdir("~\\sub", exec), join(home, "sub"));
});

test("resolveWorkdir: relative paths resolve against the session cwd, absolute pass through", () => {
	const exec = { agent: { session: { header: { cwd: "D:\\session\\workspace" } } } };
	assert.equal(tool.resolveWorkdir(void 0, exec), "D:\\session\\workspace");
	assert.equal(tool.resolveWorkdir("sub", exec), resolve("D:\\session\\workspace", "sub"));
	assert.equal(tool.resolveWorkdir("/abs/dir", exec), "/abs/dir");
	assert.equal(tool.resolveWorkdir("/d/abs/msys", exec), "/d/abs/msys");
});

test("spawnSpec: prepends Git runtime dirs and injects SHELL/HOME", () => {
	withGitRoot((gitRoot) => {
		const exec = makeExecutor({}, { bashPath: join(gitRoot, "bin", "bash.exe") });
		const spec = exec.resolve({ command: "echo hi", env: { USERPROFILE: "C:\\Users\\t" } });
		const spawned = exec.spawnSpec(spec, [join(gitRoot, "bin", "bash.exe"), "-c", "echo hi"], 1000, void 0);
		assert.ok(spawned.env.PATH.startsWith(join(gitRoot, "bin") + delimiter));
		assert.equal(spawned.env.SHELL, join(gitRoot, "bin", "bash.exe"));
		assert.equal(spawned.env.HOME, "C:\\Users\\t");
		assert.equal(spawned.env.TERM, "dumb");
		assert.equal(spawned.env.NO_COLOR, "1");
		assert.equal(spawned.stdio.stdout.maxBytes, 1000);
		assert.equal(spawned.cwd, process.cwd());
	});
});

test("execute: shapes a successful foreground run and its result()", async () => {
	await withGitRoot(async (gitRoot) => {
		const spawned = [];
		const exec = makeExecutor(
			{ subprocess: { spawn: (spec) => (spawned.push(spec), fakeHandle({ stdout: "hello\n", stderr: "warn\n" })) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "echo hi" }));
		const result = await proc.result();
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, false);
		assert.equal(result.stdout.text, "hello\n");
		assert.equal(result.stderr.text, "warn\n");
		assert.equal(spawned.length, 1);
		assert.deepEqual(spawned[0].argv, [join(gitRoot, "bin", "bash.exe"), "-c", "echo hi"]);
	});
});

test("execute: result() is memoized, so repeated foreground reads are stable", async () => {
	await withGitRoot(async (gitRoot) => {
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle({ stdout: "once\n" }) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "echo once" }));
		const first = await proc.result();
		const second = await proc.result();
		assert.equal(first, second, "the same settled result object is reused");
	});
});

test("execute: classifies a BASH_TIMEOUT deadline as timedOut", async () => {
	await withGitRoot(async (gitRoot) => {
		const controller = new AbortController();
		controller.abort(new TimeoutReason("BASH_TIMEOUT", 50));
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle({ stdout: "" }) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "sleep 100", signal: controller.signal }));
		const result = await proc.result();
		assert.equal(result.timedOut, true);
		assert.equal(result.aborted, false);
	});
});

test("execute: classifies a plain cancellation as aborted", async () => {
	await withGitRoot(async (gitRoot) => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle() } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "anything", signal: controller.signal }));
		const result = await proc.result();
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, true);
	});
});

test("execute: onExpiry 'none' arms no deadline, so a slow command is not killed", async () => {
	await withGitRoot(async (gitRoot) => {
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle({ stdout: "slow\n" }) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		// A tiny timeoutMs is echoed into the result but never enforced.
		const spec = exec.resolve({ command: "sleep 100", timeoutMs: 1, onExpiry: "none" });
		const proc = await exec.execute(spec);
		const result = await proc.result();
		assert.equal(result.timedOut, false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.text, "slow\n");
	});
});

test("observed: non-consuming readers expose output without draining readOutput()", async () => {
	await withGitRoot(async (gitRoot) => {
		// A reader that records how far it was asked to read, so a consuming
		// implementation (which advances its own offset) is distinguishable.
		const makeCountingReader = (text) => {
			const offsets = [];
			return {
				offsets,
				readFrom: (fromByte) => {
					offsets.push(fromByte);
					return { text: text.slice(fromByte), lossy: false, nextOffset: text.length };
				}
			};
		};
		const stdout = makeCountingReader("observed-out\n");
		const stderr = makeCountingReader("observed-err\n");
		const exec = makeExecutor(
			{
				subprocess: {
					spawn: () => ({
						done: Promise.resolve({ exitCode: 0, signal: null }),
						collected: { stdout, stderr },
						terminate() {}
					})
				}
			},
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "echo hi" }));
		await proc.done;

		// The registry pump reads at absolute offsets from 0 and must not steal
		// bytes from the model's consuming cursor.
		assert.equal(proc.observed.stdout.readFrom(0).text, "observed-out\n");
		assert.equal(proc.observed.stderr.readFrom(0).text, "observed-err\n");
		assert.deepEqual(stdout.offsets, [0], "observed read asked at offset 0 only");

		// The consuming read still returns the whole stream: nothing was stolen.
		const read = proc.readOutput();
		assert.match(read.delta, /observed-out/);
		assert.match(read.delta, /\[stderr\]\nobserved-err/);
	});
});

test("kill: terminates the running process exactly once", async () => {
	await withGitRoot(async (gitRoot) => {
		let terminated = 0;
		const exec = makeExecutor(
			{
				subprocess: {
					spawn: () => ({
						done: new Promise(() => {}),
						collected: { stdout: fakeReader(""), stderr: fakeReader("") },
						terminate: () => terminated++
					})
				}
			},
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "sleep 100", onExpiry: "none" }));
		assert.equal(proc.status, "running");
		assert.equal(proc.kill(), true);
		assert.equal(terminated, 1);
		assert.equal(proc.status, "killed");
		assert.equal(proc.kill(), false);
		assert.equal(terminated, 1);
	});
});

test("a provider rejection settles the handle as killed and carries the note on the read path", async () => {
	await withGitRoot(async (gitRoot) => {
		const exec = makeExecutor(
			{
				subprocess: {
					spawn: () => ({
						done: Promise.reject(new Error("ENOENT: no such file")),
						collected: { stdout: fakeReader(""), stderr: fakeReader("") },
						terminate() {}
					})
				}
			},
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "nope", onExpiry: "none" }));
		await proc.done;
		// The seam contract: a rejected provider settles as `killed`, and the
		// failure text reaches the model through the stderr read path.
		assert.equal(proc.status, "killed");
		const read = proc.readOutput();
		assert.match(read.delta, /subprocess failed before reporting an outcome: Error: ENOENT/);
		// The observed stderr reader serves the same note to the registry pump.
		assert.match(proc.observed.stderr.readFrom(0).text, /subprocess failed before reporting an outcome/);
		// ...while result() is the infrastructure-failure channel.
		await assert.rejects(() => proc.result(), /ENOENT/);
	});
});

test("execute: a synchronous spawn failure still yields a handle whose result() rejects", async () => {
	await withGitRoot(async (gitRoot) => {
		const exec = makeExecutor(
			{
				subprocess: {
					spawn: () => {
						throw new Error("spawn EINVAL");
					}
				}
			},
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const proc = await exec.execute(exec.resolve({ command: "nope", onExpiry: "none" }));
		await proc.done;
		assert.equal(proc.status, "killed");
		await assert.rejects(() => proc.result(), /spawn EINVAL/);
	});
});

/**
 * Mount the model-facing tool on a mock context and return its registered
 * definition, so `execute` can be driven directly.
 *
 * The `jobs` stub mirrors the real registry's contract closely enough to
 * catch the two integration mistakes a hand-written copy made before:
 * - `owner` is the session **id** (`@deepseek-ai/dsh-jobs-local` resolves it
 *   through `agents.get(session)`), so passing the Agent object misses the
 *   lookup and the real registry throws
 *   `session "[object Object]" has no live agent`.
 * - output reaches the model only through the spec's `output` pull sources,
 *   which the registry pumps; the old `readOutput()` hook is ignored.
 *
 * `wait` reports the job as still running until `settle` is called, which is
 * what drives the promote-on-timeout path.
 */
function mountTool({ agents = {}, jobs = true, execute, wait } = {}, config = {}) {
	let registered;
	const started = [];
	const reads = [];
	const removed = [];
	const killed = [];
	const chunks = [];
	const jobView = (id) => ({
		id,
		status: "running",
		detail: void 0,
		output: { spillPaths: [] }
	});
	const stub = {
		start(spec) {
			if (spec.owner !== void 0 && agents[spec.owner] === void 0) {
				throw new Error(`session "${spec.owner}" has no live agent (background job owner must be live)`);
			}
			started.push(spec);
			spec.run();
			return "bash-1";
		},
		read(id) {
			reads.push(id);
			return { chunks, lossy: false, job: jobView(id) };
		},
		async wait(id) {
			if (wait !== void 0) return wait();
			return { ...jobView(id), status: "completed" };
		},
		kill(id, owner, reason) {
			killed.push({ id, owner, reason });
		},
		remove(id) {
			removed.push(id);
		}
	};
	const ctx = {
		tools: {
			register(definition) {
				registered = definition;
				return () => {};
			}
		},
		systemPrompt: { section() {} },
		logger: { warn() {} },
		shellEnv: { collect: () => ({}) },
		fiber: { state: 1 },
		gitbash: {
			sandboxMode: void 0,
			resolve: (request) => ({ command: request.command, workdir: request.workdir ?? process.cwd(), timeoutMs: request.timeoutMs ?? 12e4, onExpiry: request.onExpiry ?? "kill", stdoutMaxBytes: 64e3, ...request }),
			execute:
				execute ??
				(async (spec) => ({
					status: "completed",
					exitCode: 0,
					signal: null,
					observed: {
						stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
						stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) }
					},
					done: Promise.resolve(),
					readOutput: () => ({ delta: "", lossy: false }),
					kill: () => true,
					result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: "fg-out\n", truncated: false }, stderr: { text: "", truncated: false } })
				}))
		},
		get(service) {
			return service === "jobs" ? (jobs ? stub : void 0) : void 0;
		},
		inject(_services, callback) {
			// Mirror the host: the jobs-aware registration only happens once the
			// service is present.
			if (jobs) callback({ jobs: stub, effect: () => () => {} });
		}
	};
	tool.apply(ctx, config);
	return { definition: registered, started, reads, removed, killed, chunks };
}

test("background: the job is registered with the owner's session id, not the Agent object", async () => {
	const agent = { id: "session-abc", session: { header: { cwd: process.cwd() } } };
	const { definition, started } = mountTool({ agents: { "session-abc": agent } });
	const value = await definition.execute({ command: "sleep 100", description: "Sleep for a while", run_in_background: true }, { agent, signal: new AbortController().signal });
	assert.equal(value.kind, "background");
	assert.equal(value.jobId, "bash-1");
	assert.equal(started.length, 1);
	// The regression: the owner must be the id string, so the registry's
	// `agents.get(session)` lookup hits. An Agent object fails that lookup.
	assert.equal(started[0].owner, "session-abc");
});

test("background: the job declares pull sources, so output reaches the registry ring", async () => {
	const { definition, started } = mountTool();
	await definition.execute({ command: "echo hi", description: "Echo", run_in_background: true }, { signal: new AbortController().signal });
	// The regression: without `output` the registry has nothing to pump, so a
	// finished job reads as empty forever.
	assert.ok(Array.isArray(started[0].output), "spec.output is an array of pull sources");
	assert.deepEqual(started[0].output.map((s) => s.channel), ["stdout", "stderr"]);
	assert.equal(typeof started[0].output[0].read, "function");
	// A read before the process exists yields nothing (never throws).
	assert.deepEqual(started[0].output[0].read(0), { text: "", nextOffset: 0, lossy: false });
});

test("background: a pull source reads the process's observed streams by absolute offset", async () => {
	let observedFrom;
	const fakeProc = {
		status: "completed",
		exitCode: 0,
		signal: null,
		observed: {
			stdout: {
				readFrom: (from) => {
					observedFrom = from;
					return { text: "job-out\n", nextOffset: from + 8, lossy: false };
				}
			},
			stderr: { readFrom: (from) => ({ text: "", nextOffset: from, lossy: false }) }
		},
		done: Promise.resolve(),
		readOutput: () => ({ delta: "", lossy: false }),
		kill: () => true,
		result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 12e4, stdout: { text: "job-out\n", truncated: false }, stderr: { text: "", truncated: false } })
	};
	const { definition, started } = mountTool({ execute: async () => fakeProc });
	await definition.execute({ command: "echo hi", description: "Echo", run_in_background: true }, { signal: new AbortController().signal });
	// The starter spawned the process during registry.start -> spec.run().
	const source = started[0].output[0];
	assert.equal(source.read(0).text, "job-out\n");
	assert.equal(observedFrom, 0, "the registry reads at its own absolute offset");
	assert.equal(source.read(8).text, "job-out\n", "non-consuming: a later offset is passed through untouched");
});

test("background: an unowned call still starts without an owner", async () => {
	const { definition, started } = mountTool();
	const value = await definition.execute({ command: "sleep 1", description: "Sleep briefly", run_in_background: true }, { signal: new AbortController().signal });
	assert.equal(value.kind, "background");
	assert.equal(started[0].owner, void 0);
});

test("background: run_in_background is rejected when disabled by config", async () => {
	const { definition } = mountTool({}, { enableRunInBackground: false });
	await assert.rejects(
		() => definition.execute({ command: "sleep 1", description: "Sleep briefly", run_in_background: true }, { signal: new AbortController().signal }),
		/run_in_background is disabled/
	);
});

test("background: a missing jobs service names the packages to load", async () => {
	const { definition } = mountTool({ jobs: false });
	await assert.rejects(
		() => definition.execute({ command: "sleep 1", description: "Sleep briefly", run_in_background: true }, { signal: new AbortController().signal }),
		/load @deepseek-ai\/dsh-jobs and @deepseek-ai\/dsh-tool-jobs/
	);
});

test("promote: a foreground call that outlives its wait returns kind 'promoted' with the job id", async () => {
	// The registry reports the job as still running, which is exactly the
	// promote path: the call stops waiting without killing the command.
	const { definition, reads, killed, removed } = mountTool({
		wait: async () => ({ id: "bash-1", status: "running", detail: void 0, output: { spillPaths: [] } })
	});
	const value = await definition.execute({ command: "sleep 100", description: "Sleep", timeoutMs: 10 }, { signal: new AbortController().signal });
	assert.equal(value.kind, "promoted");
	assert.equal(value.jobId, "bash-1");
	assert.equal(value.timeoutMs, 10);
	assert.equal(typeof value.output, "string");
	assert.equal(reads.length, 1, "the promoted result embeds one consuming ring read");
	assert.equal(killed.length, 0, "a promoted command keeps running");
	assert.equal(removed.length, 0, "its record stays with the job, not the call");
});

test("promote: the promoted text carries the still-running marker and the hand-off", async () => {
	const { definition, chunks } = mountTool({
		wait: async () => ({ id: "bash-1", status: "running", detail: void 0, output: { spillPaths: [] } })
	});
	chunks.push({ channel: "stdout", text: "partial output\n" });
	const value = await definition.execute({ command: "sleep 100", description: "Sleep", timeoutMs: 10 }, { signal: new AbortController().signal });
	const text = definition.output.render(void 0, value)[0].text;
	assert.match(text, /partial output/);
	assert.match(text, /\[still running after 10ms; moved to background job bash-1\]/);
	assert.match(text, /read newer output with job_output/);
});

test("promote: a settled foreground call removes the record and returns kind 'foreground'", async () => {
	const { definition, removed } = mountTool();
	const value = await definition.execute({ command: "echo hi", description: "Echo" }, { signal: new AbortController().signal });
	assert.equal(value.kind, "foreground");
	assert.equal(value.exitCode, 0);
	assert.deepEqual(removed, ["bash-1"], "a collected foreground record leaves with the call");
});

test("the timeoutMs description advertises promotion when it is enabled", () => {
	// `defineTool` converts the parameter spec into JSON Schema, so the
	// description lives under `properties`.
	const descriptionOf = (definition) => definition.parameters.properties.timeoutMs.description;
	const promoted = mountTool().definition;
	const killed = mountTool({}, { promoteOnTimeout: false }).definition;
	assert.match(descriptionOf(promoted), /moves to the background as a job/);
	assert.match(descriptionOf(killed), /kills the command on expiry/);
});

test("real Git Bash spawn (skipped when no installation detected)", { skip: !findGitBash(void 0) }, async () => {
	const bash = findGitBash(void 0);
	await new Promise((resolvePromise, reject) => {
		const child = spawn(bash, ["-c", "echo gitbash-smoke-ok"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("close", (code) => {
			try {
				assert.equal(code, 0, `bash exited ${code}`);
				assert.match(out, /gitbash-smoke-ok/);
				resolvePromise();
			} catch (error) {
				reject(error);
			}
		});
	});
});

test("real Git Bash runs git coreutils through the injected PATH (skipped when no installation detected)", { skip: !findGitBash(void 0) }, async () => {
	const bash = findGitBash(void 0);
	await new Promise((resolvePromise, reject) => {
		const entries = gitPathEntries(bash);
		const env = { ...process.env, PATH: [...entries, process.env.PATH ?? ""].join(";") };
		const child = spawn(bash, ["-c", "which git && which grep && echo coreutils-ok"], { stdio: ["ignore", "pipe", "pipe"], env });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("close", (code) => {
			try {
				assert.equal(code, 0);
				assert.match(out, /coreutils-ok/);
				resolvePromise();
			} catch (error) {
				reject(error);
			}
		});
	});
});

test("real Git Bash executor: a background process exposes observed output to the pump", { skip: !findGitBash(void 0) }, async () => {
	const bash = findGitBash(void 0);
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-real-"));
	try {
		// A real subprocess service stand-in: collect both streams, expose the
		// same `collected` readers the host subprocess seam returns.
		const exec = makeExecutor(
			{
				subprocess: {
					spawn: (spec) => {
						const child = spawn(spec.argv[0], spec.argv.slice(1), {
							cwd: spec.cwd,
							env: { ...process.env, ...spec.env },
							stdio: ["ignore", "pipe", "pipe"]
						});
						let out = "";
						let err = "";
						child.stdout.on("data", (d) => (out += d));
						child.stderr.on("data", (d) => (err += d));
						const reader = (get) => ({ readFrom: (from) => ({ text: get().slice(from), lossy: false, nextOffset: get().length }) });
						return {
							done: new Promise((r) => child.on("close", (code) => r({ exitCode: code, signal: null }))),
							collected: { stdout: reader(() => out), stderr: reader(() => err) },
							terminate: () => child.kill()
						};
					}
				}
			},
			{ bashPath: bash }
		);
		const proc = await exec.execute(exec.resolve({ command: "echo real-observed-ok", onExpiry: "none" }));
		await proc.done;
		assert.equal(proc.exitCode, 0);
		// The registry pump path: non-consuming read of what the process wrote.
		assert.match(proc.observed.stdout.readFrom(0).text, /real-observed-ok/);
		// The consuming path still sees it too.
		assert.match(proc.readOutput().delta, /real-observed-ok/);
		const result = await proc.result();
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout.text, /real-observed-ok/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
