/**
 * End-to-end integration tests for dsh-gitbash against the REAL runtime
 * services (`@deepseek-ai/dsh-jobs-local` and `@deepseek-ai/dsh-subprocess-local`),
 * not hand-written stubs.
 *
 * This is the test that would have caught both integration bugs a previous
 * hand-written copy shipped:
 * - the job owner must be the session id, or the real registry's
 *   `agents.get(session)` lookup misses and `start()` throws; and
 * - output reaches the model only through the spec's `output` pull sources,
 *   which the real registry pumps into its ring. Without them a job finishes
 *   with the right exit code but reads as permanently empty.
 *
 * It is skipped when no Git Bash installation is present.
 *
 * Run: `node --test test/`
 *
 * @module dsh-gitbash/test/integration
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import * as toolJobs from "@deepseek-ai/dsh-tool-jobs";
import { GitBashExecutor, findGitBash } from "../lib/executor.js";
import * as tool from "../lib/tool.js";

const hasGitBash = findGitBash(void 0) !== void 0;

/**
 * Poll until `predicate` holds or the budget expires. The real registry pumps
 * pull sources on its own cadence, so a read right after `start()` may
 * legitimately be empty.
 * @param predicate - condition to await.
 * @param timeoutMs - total budget.
 * @returns true when the predicate held, false on timeout.
 */
async function waitUntil(predicate, timeoutMs = 8000) {
	const deadlineAt = Date.now() + timeoutMs;
	while (Date.now() < deadlineAt) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
}

/**
 * Boot a real Cordis context with the real subprocess provider, the real job
 * registry and its controller, the Git Bash executor, and the model-facing
 * tool — the same service graph the profile composes, minus unrelated plugins.
 *
 * `@deepseek-ai/dsh-tool-jobs` matters: `JobRegistry.start()` refuses work
 * while no attached controller serves the owner, so without it `start()`
 * fails with "no job controller serves this agent".
 *
 * `ctx.plugin()` returns an awaitable Fiber that resolves once the plugin's
 * services are registered, which replaces the host's own boot sequencing.
 * @returns the live context, the agent registry, and the tool definition.
 */
async function bootRealStack() {
	const ctx = new Context();
	// A minimal agent registry: `resolveOwner` looks the session id up here.
	const agents = new Map();
	ctx.provide("agents", {
		get: (id) => agents.get(id),
		list: () => [...agents.values()]
	});
	await ctx.plugin(LocalSubprocessRuntime);
	await ctx.plugin(LocalJobRegistry);
	await ctx.plugin(toolJobs);
	await ctx.plugin(GitBashExecutor, { timeoutMs: 12e4, maxTimeoutMs: 6e5 });
	let registered;
	ctx.provide("tools", {
		register(definition) {
			registered = definition;
			return () => {};
		}
	});
	ctx.provide("systemPrompt", { section: () => {}, getSectionOrder: () => 105 });
	ctx.provide("shellEnv", { collect: () => ({}) });
	return { ctx, agents, definition: () => registered };
}

/** Tear down a booted stack without letting a teardown error mask a failure. */
async function shutdown(ctx) {
	try {
		await ctx.fiber.dispose();
	} catch {
		// A throwing teardown must not turn a passing assertion into a failure.
	}
}

/**
 * A stand-in live Agent, shaped like the real one for the parts the registry
 * touches: `id` (the owner key) and `ctx` (its scope, whose `effect` installs
 * the owner-disposal cleanup that cancels the owner's jobs).
 * @param ctx - the booted stack's context.
 * @param id - the session id the registry resolves.
 * @param cwd - the session workspace the tool resolves a relative workdir against.
 * @returns the agent record to put in the agent registry.
 */
function fakeAgent(ctx, id, cwd) {
	return {
		id,
		ctx,
		session: { header: { cwd } }
	};
}

test("integration: a background job's output is readable through the real registry", { skip: !hasGitBash }, async () => {
	const { ctx, agents, definition } = await bootRealStack();
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-int-"));
	try {
		const agent = fakeAgent(ctx, "session-int-1", dir);
		agents.set("session-int-1", agent);
		tool.apply(ctx, { enableRunInBackground: true, promoteOnTimeout: false });
		await new Promise((r) => setTimeout(r, 50));

		const value = await definition().execute(
			{
				command: "echo integration-out; echo integration-err 1>&2",
				description: "Emit output on both streams",
				run_in_background: true
			},
			{ agent, signal: new AbortController().signal }
		);
		assert.equal(value.kind, "background");

		// The model-facing read: this is what `job_output` does. Without the
		// spec's pull sources the registry ring stays empty forever, so the
		// assertion below is the whole point of the test.
		//
		// `readAt` (not `read`) is used while polling: `read` is consuming, so
		// polling it would drain the ring into a later discarded read.
		const registry = ctx.jobs;
		const collected = [];
		const ok = await waitUntil(() => {
			const read = registry.readAt(value.jobId, 0, "session-int-1");
			collected.length = 0;
			collected.push(...(read.chunks ?? []));
			const text = collected.map((c) => c.text).join("");
			return text.includes("integration-out") && text.includes("integration-err");
		});
		const text = collected.map((c) => c.text).join("");
		assert.ok(ok, `expected both streams in the job ring, got: ${JSON.stringify(text)}`);
		assert.match(text, /integration-out/);
		assert.match(text, /integration-err/);
		// The registry tags each chunk with its channel, so stdout/stderr stay
		// distinguishable in the ring the model reads.
		const channels = new Set(collected.map((c) => c.channel));
		assert.ok(channels.has("stdout"), "stdout chunks carry their channel");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await shutdown(ctx);
	}
});

test("integration: an unknown owner session is refused by the real registry", { skip: !hasGitBash }, async () => {
	const { ctx } = await bootRealStack();
	try {
		// No agent registered under this id: the real registry's resolveOwner
		// must reject, which is the failure the Agent-object bug produced.
		const registry = ctx.jobs;
		assert.throws(
			() =>
				registry.start({
					kind: "bash",
					label: "x",
					owner: "session-not-registered",
					run: () => ({ cancel() {}, done: Promise.resolve({ status: "completed" }) })
				}),
			/no live agent|agent registry/
		);
	} finally {
		await shutdown(ctx);
	}
});

test("integration: passing an Agent object as the owner is what the real registry rejects", { skip: !hasGitBash }, async () => {
	const { ctx, agents } = await bootRealStack();
	try {
		const agent = { id: "session-int-2", session: { header: { cwd: process.cwd() } } };
		agents.set("session-int-2", agent);
		const registry = ctx.jobs;
		// This is the exact shape of the old bug: the Agent object instead of
		// its id. The registry treats the value as a session id, so the lookup
		// misses and the error names the stringified object.
		assert.throws(
			() =>
				registry.start({
					kind: "bash",
					label: "x",
					owner: agent,
					run: () => ({ cancel() {}, done: Promise.resolve({ status: "completed" }) })
				}),
			/\[object Object\]|no live agent/
		);
	} finally {
		await shutdown(ctx);
	}
});

test("integration: a foreground call settles through the real executor and returns its output", { skip: !hasGitBash }, async () => {
	const { ctx } = await bootRealStack();
	const dir = mkdtempSync(join(tmpdir(), "dsh-gitbash-int-fg-"));
	try {
		// The stack already mounted the executor as `ctx.gitbash`; a second
		// instance would collide on the service name.
		const exec = ctx.gitbash;
		const proc = await exec.execute(exec.resolve({ command: "echo foreground-ok", workdir: dir }));
		const result = await proc.result();
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout.text, /foreground-ok/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await shutdown(ctx);
	}
});

test("integration: observed readers do not consume what readOutput() returns", { skip: !hasGitBash }, async () => {
	const { ctx } = await bootRealStack();
	try {
		const exec = ctx.gitbash;
		const proc = await exec.execute(exec.resolve({ command: "echo shared-bytes", onExpiry: "none" }));
		await proc.done;
		// The registry pump reads first (absolute offsets); the model's
		// consuming read must still receive every byte.
		const observed = proc.observed.stdout.readFrom(0).text;
		assert.match(observed, /shared-bytes/);
		const consumed = proc.readOutput();
		assert.match(consumed.delta, /shared-bytes/, "observed reads must not steal bytes from readOutput()");
	} finally {
		await shutdown(ctx);
	}
});
