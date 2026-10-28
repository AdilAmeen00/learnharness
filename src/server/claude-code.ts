import type { ClaudeCodeConnectionDto } from "../core/contracts/claude-code.ts";
import { claudeCodeSettingsOf } from "../core/settings.ts";
import { stores } from "./stores.ts";
import { claudeCodeConnected, claudeCodePlanLimits, refreshClaudeCodeCatalog, refreshClaudeCodeModels, refreshClaudeCodeStatus } from "../agent/claude-code/status.ts";

/** The Settings row's data (GET /api/claude-code). `recheck` re-probes the
 *  CLI and the account's model list instead of reading the caches. */
export async function claudeCodeConnection(recheck = false): Promise<ClaudeCodeConnectionDto> {
	const status = await refreshClaudeCodeStatus(recheck);
	if (recheck) await refreshClaudeCodeModels(true);
	else await refreshClaudeCodeCatalog();
	const settings = claudeCodeSettingsOf(stores.settingsStore.readSettings());
	const limits = claudeCodePlanLimits();
	return {
		installed: status.installed,
		...(status.version ? { version: status.version } : {}),
		loggedIn: status.loggedIn,
		...(status.authMethod ? { authMethod: status.authMethod } : {}),
		...(status.subscriptionType ? { subscriptionType: status.subscriptionType } : {}),
		connected: claudeCodeConnected(),
		...(status.error ? { error: status.error } : {}),
		transport: settings.transport,
		allowBackgroundUse: settings.allowBackgroundUse,
		...(limits ? { limits: { fiveHour: limits.fiveHour, sevenDay: limits.sevenDay, at: limits.at } } : {}),
	};
}
