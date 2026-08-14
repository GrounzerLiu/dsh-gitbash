/**
 * Tests for dsh-gitbash.
 *
 * Pure functions (`findGitBash`, `gitBashCandidates`, `gitPathEntries`,
 * `msysToWindows`) are tested against throwaway directory trees. The
 * executor's resolve/spawn/run/start logic is exercised with a mock
 * `subprocess` service, so those tests run on any platform without a Git
 * Bash installation. The real-spawn smoke tests run only when a Git Bash
 * installation is actually detected (win32).
 *
 * Run: `node --test test/`
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
	assert.ok(candidates.includes("C:\\Program Files\\Git\\bin\\bash.exe"));
	assert.ok(candidates.includes("C:\\Program Files\\Git\\usr\\bin\\bash.exe"));
	assert.ok(candidates.includes("C:\\Program Files (x86)\\Git\\bin\\bash.exe"));
	assert.ok(candidates.includes("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"));
	assert.ok(candidates.includes("C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe"));
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

test("resolve: clamps timeoutMs to maxTimeoutMs", () => {
	const exec = makeExecutor();
	assert.equal(exec.resolve({ command: "echo hi", timeoutMs: 1e9 }).timeoutMs, 6e5);
	assert.equal(exec.resolve({ command: "echo hi", timeoutMs: 1000 }).timeoutMs, 1000);
	assert.equal(exec.resolve({ command: "echo hi" }).timeoutMs, 12e4);
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

test("run: shapes a successful foreground run through the mock subprocess", async () => {
	await withGitRoot(async (gitRoot) => {
		const spawned = [];
		const exec = makeExecutor(
			{ subprocess: { spawn: (spec) => (spawned.push(spec), fakeHandle({ stdout: "hello\n", stderr: "warn\n" })) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const result = await exec.run(exec.resolve({ command: "echo hi" }));
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, false);
		assert.equal(result.stdout.text, "hello\n");
		assert.equal(result.stderr.text, "warn\n");
		assert.equal(spawned.length, 1);
		assert.deepEqual(spawned[0].argv, [join(gitRoot, "bin", "bash.exe"), "-c", "echo hi"]);
	});
});

test("run: classifies a BASH_TIMEOUT deadline as timedOut", async () => {
	await withGitRoot(async (gitRoot) => {
		const controller = new AbortController();
		controller.abort(new TimeoutReason("BASH_TIMEOUT", 50));
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle({ stdout: "" }) } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const result = await exec.run(exec.resolve({ command: "sleep 100", signal: controller.signal }));
		assert.equal(result.timedOut, true);
		assert.equal(result.aborted, false);
	});
});

test("run: classifies a plain cancellation as aborted", async () => {
	await withGitRoot(async (gitRoot) => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));
		const exec = makeExecutor(
			{ subprocess: { spawn: () => fakeHandle() } },
			{ bashPath: join(gitRoot, "bin", "bash.exe") }
		);
		const result = await exec.run(exec.resolve({ command: "anything", signal: controller.signal }));
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, true);
	});
});

test("start: kill terminates the running process exactly once", async () => {
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
		const proc = exec.start(exec.resolve({ command: "sleep 100" }));
		assert.equal(proc.status, "running");
		assert.equal(proc.kill(), true);
		assert.equal(terminated, 1);
		assert.equal(proc.status, "killed");
		assert.equal(proc.kill(), false);
		assert.equal(terminated, 1);
	});
});

test("start: a spawn failure surfaces as the failed status, not killed", async () => {
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
		const proc = exec.start(exec.resolve({ command: "nope" }));
		await proc.done;
		assert.equal(proc.status, "failed");
		assert.match(proc.spawnError, /ENOENT/);
		const read = proc.readOutput();
		assert.match(read.delta, /spawn failed: Error: ENOENT/);
	});
});

test("real Git Bash spawn (skipped when no installation detected)", { skip: !findGitBash(void 0) }, async () => {
	const bash = findGitBash(void 0);
	await new Promise((resolvePromise, reject) => {
		const child = spawn(bash, ["-c", "echo gitbash-smoke-ok && git --version"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => {
			try {
				assert.equal(code, 0, `bash exited ${code}: ${err}`);
				assert.match(out, /gitbash-smoke-ok/);
				assert.match(out, /git version/);
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
