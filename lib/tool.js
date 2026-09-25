/**
 * Model-facing `bash` tool backed by the Git Bash executor.
 *
 * A port of the shipped `@deepseek-ai/dsh-tool-bash` — same registration
 * lifecycle, background-job plumbing, promotion-on-timeout flow, output
 * schema, and presenters — with its two composition differences:
 *
 * 1. It consumes the SIBLING service `ctx.gitbash` instead of `ctx.shell`,
 *    because on win32 `ctx.shell` is owned by `@deepseek-ai/dsh-pwsh-sandbox`
 *    while the shipped POSIX bash pair is disabled by design. That is also
 *    why the `pwsh` tool keeps working unchanged.
 * 2. Its description states the Git Bash facts (Git for Windows, not
 *    file-sandboxed) rather than the generic sandbox wording.
 *
 * Keeping this file structurally aligned with the shipped tool is deliberate:
 * when that tool changes, this copy is diffed against it rather than
 * re-derived. The job-ownership type and the registry pull-source output are
 * exactly the two changes a previous hand-written copy missed.
 *
 * @module dsh-gitbash/tool
 */
import z from "@deepseek-ai/schemastery";
import { isAbsolute, resolve } from "node:path";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { ESCALATION_TARGETS, approveEscalation, canonicalPath, escalationHintMarker, sandboxDenialMarker, validateEscalationArgs } from "@deepseek-ai/dsh-sandbox";
import { DSH_ENV_PREFIX, parseExitStatus } from "@deepseek-ai/dsh-shell";

/** Cordis plugin name. */
const name = "tool-gitbash";
/** Required services: tool registry, the git bash executor, prompt sections, and managed env facts. */
const inject = ["tools", "gitbash", "systemPrompt", "shellEnv"];

/** Runtime configuration schema for the git bash tool plugin. */
const Config = z.object({
	enableRunInBackground: z.boolean().default(true),
	promoteOnTimeout: z.boolean().default(true)
});

function validateBashArgs(args) {
	if (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
	if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
	if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
	validateEscalationArgs(args.sandbox_permissions, args.justification);
}

function bashDescription(backgroundEnabled, escalationModes) {
	const background = backgroundEnabled
		? "Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`."
		: "Background execution is not available; long-running commands must finish within the timeout.";
	const sandboxed = escalationModes.length > 0;
	const policy = sandboxed
		? "Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way."
		: "Commands run with full file access (the Git Bash msys runtime cannot run under the Windows restricted-token sandbox, so this tool is not file-sandboxed).";
	const base = `Execute a bash command (\`bash -c\`) using Git Bash (Git for Windows) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. Non-zero exits are reported as \`[exit code: N]\`. Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. ` + policy + ` Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ` + background;
	if (!sandboxed) return base;
	return base + " Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.";
}

function presentBashCall(args) {
	if (args.run_in_background === true) {
		return {
			card: "generic",
			title: args.command,
			kind: "execute",
			rawInput: args.command,
			content: [{ type: "text", text: args.description }]
		};
	}
	return {
		card: "terminal",
		title: args.command,
		description: args.description,
		...(args.workdir !== void 0 ? { cwd: args.workdir } : {})
	};
}

/**
 * Present completed foreground output as a terminal; background
 * acknowledgements, promotions, and execution errors use generic fenced
 * output without an exit-status pill.
 */
function presentBashResult(args, result) {
	const block = result.content.length === 1 ? result.content[0] : void 0;
	if (block === void 0 || block.type !== "text") return void 0;
	const raw = block.text;
	const isBackground = typeof args === "object" && args !== null && args.run_in_background === true;
	const isPromoted = result.value?.kind === "promoted";
	if (isBackground || isPromoted || result.isError) {
		return {
			card: "generic",
			content: [{ type: "text", text: `\`\`\`console\n${raw.replace(/\n+$/, "")}\n\`\`\`` }]
		};
	}
	const { body, ...exit } = parseExitStatus(raw);
	return {
		card: "terminal",
		output: body,
		...exit
	};
}

/** Resolve an explicit workdir first, making a relative one session-workspace-relative. */
function resolveWorkdir(modelWorkdir, exec, policyWorkspaceRoot) {
	const headerCwd = exec.agent?.session.header.cwd;
	const sessionCwd = policyWorkspaceRoot ?? (headerCwd === void 0 ? void 0 : canonicalPath(headerCwd));
	if (modelWorkdir === void 0) return sessionCwd;
	// Expand `~` before relative-path resolution, or it would be joined onto the
	// session cwd as a literal `~` directory.
	const home = process.env.USERPROFILE;
	if (home !== void 0 && (modelWorkdir === "~" || modelWorkdir.startsWith("~/") || modelWorkdir.startsWith("~\\"))) {
		return modelWorkdir === "~" ? home : resolve(home, modelWorkdir.slice(2));
	}
	if (sessionCwd !== void 0 && !isAbsolute(modelWorkdir)) return resolve(sessionCwd, modelWorkdir);
	return modelWorkdir;
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalBashResult(result) {
	const output = (stream) => ({
		text: stream.text,
		truncated: stream.truncated,
		...(stream.spillPath !== void 0 ? { spillPath: stream.spillPath } : {})
	});
	return {
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		aborted: result.aborted,
		timeoutMs: result.timeoutMs,
		stdout: output(result.stdout),
		stderr: output(result.stderr),
		...(result.sandbox !== void 0
			? {
					sandbox: {
						mode: result.sandbox.mode,
						denied: result.sandbox.denied,
						...(result.sandbox.enforcement !== void 0 ? { enforcement: result.sandbox.enforcement } : {}),
						...(result.sandbox.runnerFailed !== void 0 ? { runnerFailed: result.sandbox.runnerFailed } : {})
					}
				}
			: {})
	};
}

/** The structured abort the foreground paths throw when the caller cancels the call. */
function toolAborted() {
	const error = new HarnessError("tool call aborted", TOOL_ABORTED);
	error.name = "AbortError";
	return error;
}

/** Canonical background-handle properties shared by the bash output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
	kind: {
		type: "string",
		required: true,
		const: "background"
	},
	jobId: {
		type: "string",
		required: true
	}
};

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 */
function processOutcome(proc) {
	return proc.status === "killed"
		? {
				status: "killed",
				detail: proc.signal !== null ? `signal: ${proc.signal}` : "killed before exit"
			}
		: {
				status: "completed",
				detail: `exit code: ${proc.exitCode ?? 0}`
			};
}

/**
 * The process's non-consuming stream readers as registry pull sources. They
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing, and the
 * pump keeps the model's consuming cursor untouched.
 * @param proc - the started process, once the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
function processSources(proc) {
	const source = (channel) => ({
		channel,
		read: (fromByte) => {
			const live = proc();
			return live === void 0
				? {
						text: "",
						nextOffset: fromByte,
						lossy: false
					}
				: live.observed[channel].readFrom(fromByte);
		}
	});
	return [source("stdout"), source("stderr")];
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a
 * partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param outcome - projects the settled process into the job outcome.
 * @returns synchronous job hooks whose completion includes preparation and process settlement.
 */
function processJob(start, outcome) {
	const controller = new AbortController();
	let process;
	return {
		cancel: (reason) => {
			if (controller.signal.aborted) return;
			controller.abort(reason);
			process?.kill();
		},
		done: (async () => {
			try {
				process = await start(controller.signal);
				try {
					if (controller.signal.aborted) process.kill();
				} finally {
					await process.done;
				}
				return outcome(process);
			} catch (error) {
				return {
					status: controller.signal.aborted && process === void 0 ? "killed" : "failed",
					detail: error instanceof Error ? error.message : String(error)
				};
			}
		})()
	};
}

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
	if (!output.truncated) return output.text;
	return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}

/** Shape one finished run into the text the model sees: stdout, stderr, then exit-status markers. */
function renderResult(result, escalationModes = []) {
	const out = streamText(result.stdout);
	const err = streamText(result.stderr);
	let body = out;
	if (err.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${err}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers = [];
	if (result.sandbox?.denied) {
		markers.push(sandboxDenialMarker(result.sandbox.mode));
		if (escalationModes.length > 0) markers.push(escalationHintMarker("command"));
	}
	if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
	if (result.stopped !== void 0) markers.push(`[stopped: ${result.stopped}]`);
	if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
	else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
	if (markers.length === 0) return body;
	if (!body.endsWith("\n")) body += "\n";
	return body + markers.join("\n");
}

/**
 * The ring chunks of one consuming registry read as the shell tools render a
 * process read: stdout chunks in order, then every stderr chunk in one
 * `[stderr]` section, so the output a foreground call hands over when it
 * stops waiting reads exactly like the `job_output` reads that follow it.
 * @param chunks - the chunks since the model cursor, in offset order.
 * @returns the delta text, possibly empty.
 */
function ringDelta(chunks) {
	const out = chunks.filter((chunk) => chunk.channel !== "stderr").map((chunk) => chunk.text).join("");
	const err = chunks.filter((chunk) => chunk.channel === "stderr").map((chunk) => chunk.text).join("");
	const separator = out.length > 0 && !out.endsWith("\n") ? "\n" : "";
	return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : "");
}

/**
 * Shape a foreground call that stopped waiting into the text the model sees:
 * the output captured so far (one consuming registry read taken at that
 * point, so `job_output` continues exactly after it), then the still-running
 * marker and the job hand-off guidance.
 * @param promoted - the promoted result value.
 * @returns the model-facing text for a promoted call.
 */
function renderPromoted(promoted) {
	return `${promoted.output.length > 0 ? (promoted.output.endsWith("\n") ? promoted.output : `${promoted.output}\n`) : ""}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`;
}

/**
 * Append the dropped-output notice (naming the job's spill files) and the
 * sandbox notices to one foreground read of the job ring.
 * @param delta - the read's chunks as rendered text.
 * @param lossy - whether bytes before the delta were evicted unread.
 * @param spillPaths - the complete-stream files the job currently advertises.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
function renderJobRead(delta, lossy, spillPaths, sandbox, escalationModes = []) {
	const notices = [];
	if (lossy) notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(", ") : "(unavailable)"}]`);
	if (sandbox?.runnerFailed) notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`);
	else if (sandbox?.denied) {
		notices.push(sandboxDenialMarker(sandbox.mode));
		if (escalationModes.length > 0) notices.push(escalationHintMarker("command"));
	}
	if (notices.length === 0) return delta;
	return `${delta}${delta.length > 0 && !delta.endsWith("\n") ? "\n" : ""}${notices.join("\n")}`;
}

function apply(ctx, config = {}) {
	const backgroundEnabled = config.enableRunInBackground ?? true;
	const promoteOnTimeout = (config.promoteOnTimeout ?? true) && backgroundEnabled;
	const defaultMode = ctx.gitbash.sandboxMode;
	const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;
	const sandboxPolicy = defaultMode === void 0 ? void 0 : ctx.get("sandboxPolicy");
	if (defaultMode !== void 0 && sandboxPolicy === void 0) throw new Error("tool-gitbash: the mounted git bash executor confines but ctx.sandboxPolicy is missing");
	/** Resolve the complete standing policy for this call when a confining executor is mounted. */
	const resolveSandboxPolicy = (exec) => sandboxPolicy?.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
	/** Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything executes. */
	const approveBashEscalation = (mode, justification, exec, standingPolicy) => {
		if (escalationModes.length === 0) throw new Error("sandbox_permissions is not available in this composition (no sandboxing executor to escalate)");
		const effectiveMode = standingPolicy.mode;
		return approveEscalation(
			{
				requestedMode: mode,
				justification,
				effectiveMode,
				subject: "command"
			},
			{
				approver: ctx.get("approval"),
				agent: exec.agent,
				callId: exec.callId,
				toolName: "bash",
				signal: exec.signal
			}
		);
	};
	ctx.systemPrompt.section({
		name: "tool:bash",
		order: 105,
		text: "Check the [exit code: N] marker on every bash result; investigate failures before moving on."
	});
	/**
	 * One registration of the `bash` tool. With a registry, every call
	 * registers its process as a job at its start; without one the tool is
	 * foreground-only and the executor's deadline kills the command.
	 */
	const bashTool = (jobs) => {
		const background = jobs !== void 0;
		const promote = background && promoteOnTimeout;
		/** Register the command as a job; the process spawns inside the starter, after admission. */
		const startJob = (registry, args, exec, spec) => {
			let proc;
			let stopped;
			return {
				id: registry.start({
					kind: "bash",
					label: args.command,
					...(exec.agent ? { owner: exec.agent.id } : {}),
					output: processSources(() => proc),
					run: () => {
						const hooks = processJob(async (signal) => {
							proc = await ctx.gitbash.execute({
								...spec,
								signal
							});
							return proc;
						}, (started) => processOutcome(started));
						return {
							done: hooks.done,
							cancel: (reason) => {
								stopped = reason;
								hooks.cancel(reason);
							}
						};
					}
				}),
				process: () => proc,
				stopped: () => stopped
			};
		};
		/** Wait on a registered foreground command until it settles or the timeout passes. */
		const waitOnJob = async (registry, attached, exec, spec) => {
			const owner = exec.agent?.id;
			const timeoutMs = spec.timeoutMs;
			/**
			 * Stop the job on this call's own account and stay on it until it
			 * settles, so the settlement is `awaited` and no completion notice
			 * follows a result this call already carries; the record then leaves
			 * with the call, as the model never saw the id.
			 */
			const stop = async (reason) => {
				registry.kill(attached.id, owner, reason);
				const settled = await registry.wait(attached.id, timeoutMs, owner);
				if (settled.status !== "running" && settled.status !== "stopping") registry.remove(attached.id, owner);
				return settled;
			};
			let view;
			try {
				view = await registry.wait(attached.id, timeoutMs, owner, exec.signal);
			} catch {
				await stop("tool call aborted");
				throw toolAborted();
			}
			if ((view.status === "running" || view.status === "stopping") && attached.process() === void 0) {
				await stop("timed out during preparation");
				return {
					kind: "foreground",
					exitCode: null,
					signal: null,
					timedOut: true,
					aborted: false,
					timeoutMs,
					stdout: {
						text: "",
						truncated: false
					},
					stderr: {
						text: "",
						truncated: false
					},
					...(spec.sandboxPolicy !== void 0
						? {
								sandbox: {
									mode: spec.sandboxPolicy.mode,
									denied: false
								}
							}
						: {})
				};
			}
			if (view.status === "running" || view.status === "stopping") {
				const read = registry.read(attached.id, owner);
				return {
					kind: "promoted",
					jobId: attached.id,
					timeoutMs,
					output: renderJobRead(ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes)
				};
			}
			registry.remove(attached.id, owner);
			const process = attached.process();
			if (process === void 0) throw new Error(view.detail);
			const result = await process.result();
			const stopped = attached.stopped();
			return {
				kind: "foreground",
				...canonicalBashResult(result),
				...(stopped !== void 0 ? { stopped } : {})
			};
		};
		return defineTool({
			name: "bash",
			description: bashDescription(backgroundEnabled, escalationModes),
			parameters: {
				command: {
					type: "string",
					required: true,
					description: "The bash command to execute."
				},
				description: {
					type: "string",
					required: true,
					description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".'
				},
				timeoutMs: {
					type: "number",
					description: promote
						? "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
						: "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry."
				},
				workdir: {
					type: "string",
					description: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
				},
				...(background
					? {
							run_in_background: {
								type: "boolean",
								description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
							}
						}
					: {}),
				...(escalationModes.length > 0
					? {
							sandbox_permissions: {
								type: "string",
								enum: [...escalationModes],
								description: "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval."
							},
							justification: {
								type: "string",
								description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access."
							}
						}
					: {})
			},
			output: {
				schema: {
					oneOf: [
						{
							type: "object",
							additionalProperties: false,
							properties: BACKGROUND_OUTPUT_PROPERTIES
						},
						{
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true,
									const: "promoted"
								},
								jobId: {
									type: "string",
									required: true
								},
								timeoutMs: {
									type: "number",
									required: true
								},
								output: {
									type: "string",
									required: true
								}
							}
						},
						{
							type: "object",
							additionalProperties: false,
							properties: {
								kind: {
									type: "string",
									required: true,
									const: "foreground"
								},
								exitCode: {
									required: true,
									oneOf: [{ type: "integer" }, { type: "null" }]
								},
								signal: {
									required: true,
									oneOf: [{ type: "string" }, { type: "null" }]
								},
								timedOut: {
									type: "boolean",
									required: true
								},
								aborted: {
									type: "boolean",
									required: true
								},
								stopped: { type: "string" },
								timeoutMs: {
									type: "number",
									required: true
								},
								stdout: {
									type: "object",
									additionalProperties: false,
									required: true,
									properties: {
										text: { type: "string", required: true },
										truncated: { type: "boolean", required: true },
										spillPath: { type: "string" }
									}
								},
								stderr: {
									type: "object",
									additionalProperties: false,
									required: true,
									properties: {
										text: { type: "string", required: true },
										truncated: { type: "boolean", required: true },
										spillPath: { type: "string" }
									}
								},
								sandbox: {
									type: "object",
									additionalProperties: false,
									properties: {
										mode: { type: "string", required: true },
										denied: { type: "boolean", required: true },
										enforcement: { type: "string" },
										runnerFailed: { type: "boolean" }
									}
								}
							}
						}
					]
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.kind === "background" ? `started background job ${value.jobId}` : value.kind === "promoted" ? renderPromoted(value) : renderResult(value, escalationModes)
					}
				]
			},
			async execute(args, exec) {
				validateBashArgs(args);
				const standingPolicy = resolveSandboxPolicy(exec);
				const approvedMode =
					args.sandbox_permissions !== void 0 && args.justification !== void 0
						? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
						: void 0;
				const policy = approvedMode === void 0 ? standingPolicy : { ...standingPolicy, mode: approvedMode };
				const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot);
				const dshEnv = ctx.shellEnv.collect(exec);
				const request = {
					command: args.command,
					...(workdir !== void 0 ? { workdir } : {}),
					...(args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {}),
					dshEnv,
					...(policy !== void 0 ? { sandboxPolicy: policy } : {})
				};
				if (args.run_in_background === true) {
					if (!backgroundEnabled) throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
					if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
					if (exec.signal.aborted) throw toolAborted();
					return {
						kind: "background",
						jobId: startJob(
							jobs,
							args,
							exec,
							ctx.gitbash.resolve({
								...request,
								onExpiry: "none"
							})
						).id
					};
				}
				if (jobs !== void 0 && promote) {
					const spec = ctx.gitbash.resolve({
						...request,
						onExpiry: "none"
					});
					let attached;
					try {
						attached = startJob(jobs, args, exec, spec);
					} catch (error) {
						ctx.logger.warn(`bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`);
					}
					if (attached !== void 0) return waitOnJob(jobs, attached, exec, spec);
				}
				const result = await (
					await ctx.gitbash.execute(
						ctx.gitbash.resolve({
							...request,
							signal: exec.signal
						})
					)
				).result();
				if (result.aborted) throw toolAborted();
				return {
					kind: "foreground",
					...canonicalBashResult(result)
				};
			},
			presentCall: presentBashCall,
			presentResult: presentBashResult
		});
	};
	if (!backgroundEnabled) {
		ctx.tools.register(bashTool(void 0));
		return;
	}
	let foregroundOnly = ctx.get("jobs") === void 0 ? ctx.tools.register(bashTool(void 0)) : void 0;
	ctx.inject(["jobs"], (jobCtx) => {
		foregroundOnly?.();
		foregroundOnly = void 0;
		const unregister = ctx.tools.register(bashTool(jobCtx.jobs));
		jobCtx.effect(() => () => {
			unregister();
			if (ctx.fiber.state === 2) foregroundOnly = ctx.tools.register(bashTool(void 0));
		});
	});
}

export { Config, apply, inject, name, resolveWorkdir };
