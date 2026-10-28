/**
 * GET /api/claude-code — the Settings ▸ Providers ▸ Claude Code row
 * (owner, 2026-10-28): the local CLI's state, the connection's two
 * switches, and the plan-limit reading from the latest run.
 */

export interface ClaudeCodePlanWindowDto {
	/** 0..1 of the window used. */
	utilization: number;
	/** Epoch seconds. */
	resetsAt?: number;
}

export interface ClaudeCodeConnectionDto {
	installed: boolean;
	version?: string;
	loggedIn: boolean;
	/** "claude.ai" when signed in with a subscription. */
	authMethod?: string;
	/** "max", "pro", … as Claude Code reports it. */
	subscriptionType?: string;
	/** Installed and signed in with a subscription: the models are offered. */
	connected: boolean;
	error?: string;
	transport: "cli" | "sdk";
	allowBackgroundUse: boolean;
	/** The latest run's reading; absent until a run reports one. */
	limits?: {
		fiveHour?: ClaudeCodePlanWindowDto;
		sevenDay?: ClaudeCodePlanWindowDto;
		/** When the reading was taken (epoch ms). */
		at: number;
	};
}
