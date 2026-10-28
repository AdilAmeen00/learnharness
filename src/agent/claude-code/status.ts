import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { FACTORY_SETTINGS, type ClaudeCodeSettings } from "../../core/settings.ts";
import { CLAUDE_CODE_PROVIDER, claudeCodeModel } from "./model.ts";

/**
 * Claude Code's local status: is the CLI installed, is it signed in with a
 * Claude subscription, which models does the account offer, and how much
 * of the plan's 5-hour / 7-day windows is used (read off every run's
 * rate_limit_event). Process-wide on globalThis — Next dev gives each route
 * its own module instances (the turn-liveness lesson).
 */

export interface ClaudeCodeStatus {
	installed: boolean;
	bin?: string;
	version?: string;
	loggedIn: boolean;
	/** "claude.ai" for a subscription login; anything else is refused. */
	authMethod?: string;
	subscriptionType?: string;
	error?: string;
	checkedAt: number;
}

export interface PlanWindow {
	/** 0..1 */
	utilization: number;
	/** Epoch seconds. */
	resetsAt?: number;
}

export interface PlanLimits {
	fiveHour?: PlanWindow;
	sevenDay?: PlanWindow;
	/** "allowed" | "allowed_warning" | "rejected" … as Claude Code reports it. */
	status?: string;
	at: number;
}

interface State {
	/** Where the settings come from — the composition root registers it
	 *  (the agent layer never reads the store itself). */
	settings?: () => Required<ClaudeCodeSettings>;
	status?: ClaudeCodeStatus;
	statusRequest?: Promise<ClaudeCodeStatus>;
	accountModels?: { ids: { id: string; name: string }[]; at: number };
	modelsRequest?: Promise<void>;
	limits?: PlanLimits;
}

const KEY = Symbol.for("lh.claude-code.status");
function state(): State {
	const g = globalThis as typeof globalThis & { [KEY]?: State };
	return (g[KEY] ??= {});
}

const STATUS_TTL_MS = 60_000;
const MODELS_TTL_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;

/** The current family, used when the account's list can't be read. */
const FALLBACK_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

// ─── the binary + its environment ───────────────────────────────────────────

function executable(file: string): boolean {
	try {
		accessSync(file, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The `claude` executable: LH_CLAUDE_CODE_BIN (tests), else PATH, else the
 *  native installer's ~/.local/bin. */
export function claudeCodeBin(): string | undefined {
	const override = process.env.LH_CLAUDE_CODE_BIN;
	if (override) return executable(override) ? override : undefined;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "claude");
		if (executable(candidate)) return candidate;
	}
	const local = path.join(homedir(), ".local", "bin", "claude");
	return executable(local) ? local : undefined;
}

/** The child environment: no API-key route can survive (ANTHROPIC_* is
 *  stripped, so a key saved in this app never bills), and nothing from a
 *  parent Claude Code session leaks in (CLAUDECODE, CLAUDE_CODE_*, …).
 *  CLAUDE_CONFIG_DIR stays: it says where the login lives. */
export function claudeCodeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (name.startsWith("ANTHROPIC_")) continue;
		if (name.startsWith("CLAUDE") && name !== "CLAUDE_CONFIG_DIR") continue;
		if (name === "MAX_THINKING_TOKENS") continue;
		env[name] = value;
	}
	return { ...env, ...extra } as NodeJS.ProcessEnv;
}

/** Where Claude Code keeps its config (login, projects/). */
export function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

function run(bin: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, { env: claudeCodeEnv(), timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
			if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
			else resolve(String(stdout));
		});
	});
}

// ─── status ─────────────────────────────────────────────────────────────────

async function probeStatus(): Promise<ClaudeCodeStatus> {
	const bin = claudeCodeBin();
	if (!bin) return { installed: false, loggedIn: false, checkedAt: Date.now() };
	const [version, auth] = await Promise.allSettled([run(bin, ["--version"]), run(bin, ["auth", "status"])]);
	const status: ClaudeCodeStatus = { installed: true, bin, loggedIn: false, checkedAt: Date.now() };
	if (version.status === "fulfilled") status.version = version.value.trim().split(/\s+/)[0];
	if (auth.status === "fulfilled") {
		try {
			const parsed = JSON.parse(auth.value) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
			status.loggedIn = parsed.loggedIn === true;
			status.authMethod = parsed.authMethod;
			status.subscriptionType = parsed.subscriptionType;
		} catch {
			status.error = "Claude Code's sign-in status could not be read.";
		}
	} else status.error = auth.reason instanceof Error ? auth.reason.message : "Claude Code's sign-in status could not be read.";
	return status;
}

/** Refresh the cached status (TTL-gated; `force` re-probes now). Never
 *  throws — a failed probe is an honest not-connected status. */
export function refreshClaudeCodeStatus(force = false): Promise<ClaudeCodeStatus> {
	const s = state();
	if (!force && s.status && Date.now() - s.status.checkedAt < STATUS_TTL_MS) return Promise.resolve(s.status);
	if (s.statusRequest) return s.statusRequest;
	s.statusRequest = probeStatus()
		.catch((err): ClaudeCodeStatus => ({ installed: false, loggedIn: false, error: String(err), checkedAt: Date.now() }))
		.then((status) => {
			s.status = status;
			return status;
		})
		.finally(() => {
			s.statusRequest = undefined;
		});
	return s.statusRequest;
}

export function claudeCodeStatus(): ClaudeCodeStatus | undefined {
	return state().status;
}

/** Usable: installed and signed in with a Claude subscription (an API-key
 *  login is refused — this connection exists to spend the plan, never a
 *  key). Before the first probe lands this kicks one off and says no. */
export function claudeCodeConnected(): boolean {
	const status = state().status;
	if (!status) {
		void refreshClaudeCodeStatus();
		return false;
	}
	return status.installed && status.loggedIn && status.authMethod === "claude.ai";
}

/** Test seam: pin a status without spawning anything. */
export function setClaudeCodeStatusForTests(status: ClaudeCodeStatus | undefined): void {
	state().status = status;
}

// ─── settings ───────────────────────────────────────────────────────────────

/** The composition root (src/server/stores.ts) wires the settings read. */
export function setClaudeCodeSettingsSource(source: () => Required<ClaudeCodeSettings>): void {
	state().settings = source;
}

/** The live settings — read fresh per call, factory defaults until wired. */
export function claudeCodeSettings(): Required<ClaudeCodeSettings> {
	return state().settings?.() ?? FACTORY_SETTINGS.claudeCode;
}

export function claudeCodeBackgroundAllowed(): boolean {
	return claudeCodeSettings().allowBackgroundUse;
}

// ─── models ─────────────────────────────────────────────────────────────────

let anthropicCatalog: ReturnType<typeof createModels> | undefined;
function anthropicModel(id: string): Model<Api> | undefined {
	if (!anthropicCatalog) {
		anthropicCatalog = createModels();
		for (const provider of builtinProviders()) anthropicCatalog.setProvider(provider);
	}
	return anthropicCatalog.getModel("anthropic", id);
}

/** Any Claude model id pi's Anthropic catalog knows, as a Claude Code
 *  model. Resolution never waits on the account list: a stored slot must
 *  build its engine right after a server restart. */
export function claudeCodeModelById(id: string): Model<"anthropic-messages"> | undefined {
	const base = anthropicModel(id);
	if (!base) return undefined;
	const listed = state().accountModels?.ids.find((m) => m.id === id);
	return claudeCodeModel(base, listed?.name);
}

/** The picker's list: the models Claude Code offers this account (aliases
 *  folded into their resolved ids), each once; the current family when the
 *  list can't be read. Empty while not connected. */
export function claudeCodeModels(): Model<"anthropic-messages">[] {
	if (!claudeCodeConnected()) return [];
	const ids = state().accountModels?.ids ?? FALLBACK_MODEL_IDS.map((id) => ({ id, name: "" }));
	return ids.flatMap(({ id, name }) => {
		const base = anthropicModel(id);
		return base ? [claudeCodeModel(base, name || undefined)] : [];
	});
}

interface SupportedModel {
	value: string;
	resolvedModel?: string;
	displayName?: string;
}

/** Read the account's model list through the Agent SDK (no model call). */
async function readAccountModels(bin: string): Promise<{ id: string; name: string }[]> {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const prompt = (async function* () {
		await gate;
	})();
	const q = query({
		prompt: prompt as AsyncIterable<never>,
		options: {
			cwd: homedir(),
			env: claudeCodeEnv(),
			tools: [],
			settingSources: [],
			strictMcpConfig: true,
			persistSession: false,
			pathToClaudeCodeExecutable: bin,
		},
	});
	try {
		const models = (await q.supportedModels()) as SupportedModel[];
		const seen = new Set<string>();
		const out: { id: string; name: string }[] = [];
		for (const m of models) {
			// "default" is an alias row ("Default (recommended)"); its model
			// is listed again under its own name.
			if (m.value === "default") continue;
			const id = m.resolvedModel ?? m.value;
			if (!id.startsWith("claude-") || seen.has(id)) continue;
			seen.add(id);
			out.push({ id, name: m.displayName ?? id });
		}
		return out;
	} finally {
		release();
		try {
			q.close();
		} catch {
			/* already closed */
		}
	}
}

/** Refresh the account's model list (TTL-gated, connected only). */
export function refreshClaudeCodeModels(force = false): Promise<void> {
	const s = state();
	const status = s.status;
	if (!status?.bin || !claudeCodeConnected()) return Promise.resolve();
	if (!force && s.accountModels && Date.now() - s.accountModels.at < MODELS_TTL_MS) return Promise.resolve();
	if (s.modelsRequest) return s.modelsRequest;
	s.modelsRequest = readAccountModels(status.bin)
		.then((ids) => {
			if (ids.length > 0) s.accountModels = { ids, at: Date.now() };
		})
		.catch((err) => {
			console.warn("[claude-code] model list unavailable:", err instanceof Error ? err.message : err);
		})
		.finally(() => {
			s.modelsRequest = undefined;
		});
	return s.modelsRequest;
}

/** The catalog refresh the picker and the turn gate await. */
export async function refreshClaudeCodeCatalog(): Promise<void> {
	await refreshClaudeCodeStatus();
	await refreshClaudeCodeModels();
}

// ─── plan limits ────────────────────────────────────────────────────────────

interface RateLimitInfo {
	status?: string;
	unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

function planWindow(raw: { utilization?: number; resetsAt?: number } | undefined): PlanWindow | undefined {
	if (!raw || typeof raw.utilization !== "number") return undefined;
	return { utilization: raw.utilization, ...(typeof raw.resetsAt === "number" ? { resetsAt: raw.resetsAt } : {}) };
}

/** Record one run's rate_limit_event reading (latest wins). */
export function recordPlanLimits(info: RateLimitInfo | undefined): void {
	if (!info) return;
	const windows = info.unifiedWindows ?? {};
	state().limits = {
		fiveHour: planWindow(windows.five_hour),
		sevenDay: planWindow(windows.seven_day),
		status: info.status,
		at: Date.now(),
	};
}

export function claudeCodePlanLimits(): PlanLimits | undefined {
	return state().limits;
}

export { CLAUDE_CODE_PROVIDER };
