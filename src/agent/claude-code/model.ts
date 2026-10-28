import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Claude Code as a provider (owner, 2026-10-28): the learner's own Claude
 * subscription, reached through the locally installed Claude Code CLI
 * (`claude -p`) or the Agent SDK — never an API key. One Claude Code
 * process runs each agent run (see run.ts); the app's tools are served to
 * it over MCP and executed by the app's own loop.
 */

/** The provider id Claude Code models live under (picker, slots, records). */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** The MCP server the app's tools are served under. Claude Code shows each
 *  tool to the model as `mcp__lh__<name>`; the prefix strips on the way
 *  back, so the app only ever sees its own tool names. */
export const MCP_SERVER_NAME = "lh";
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function isClaudeCodeProvider(provider: string | undefined): boolean {
	return provider === CLAUDE_CODE_PROVIDER;
}

/** A Claude Code model: pi's Anthropic catalog entry re-homed under
 *  claude-code. Cost is $0 (subscription turns cost no money per token —
 *  owner, 2026-10-28, the ChatGPT precedent). The mid-conversation request
 *  features are off: pi's request is read for its conversation and never
 *  sent, so it must stay plain user/assistant messages. */
export function claudeCodeModel(anthropic: Model<Api>, name?: string): Model<"anthropic-messages"> {
	const compat = { ...((anthropic.compat ?? {}) as Record<string, unknown>) };
	delete compat.allowedFallbackModels;
	return {
		...(anthropic as Model<"anthropic-messages">),
		api: "anthropic-messages",
		provider: CLAUDE_CODE_PROVIDER,
		name: name ?? anthropic.name,
		baseUrl: "https://claude-code.invalid",
		headers: undefined,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			...compat,
			supportsMidConvoEffort: false,
			supportsMidConvoSystemMessages: false,
			supportsMidConvoToolChanges: false,
			supportsStrictTools: false,
		},
	};
}

/** pi thinking level → Claude Code effort (the approved mapping): the
 *  five effort names pass through, minimal rides low, and no level means
 *  thinking off. */
export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export function effortForLevel(level: string | undefined): ClaudeCodeEffort | "off" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return level;
		default:
			return "off";
	}
}
