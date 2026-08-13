/**
 * Smoke tests for dsh-gitbash.
 *
 * Pure functions (`findGitBash`, `gitBashCandidates`, `gitPathEntries`) are
 * tested against throwaway directory trees; the real-spawn test runs only
 * when a Git Bash installation is actually detected (win32).
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
import { join } from "node:path";

import { GitBashExecutor, findGitBash, gitBashCandidates, gitPathEntries } from "../lib/executor.js";
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

test("findGitBash: explicit bashPath wins unconditionally", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-"));
	try {
		const result = findGitBash("Z:\\does\\not\\matter\\bash.exe", {});
		assert.equal(result, "Z:\\does\\not\\matter\\bash.exe");
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
