import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTScopeCurrent, onChatGPTChange } from "./chatgpt-bridge.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionBackgroundAllowed, nativeAdmissionCurrent, onNativeSubscriptionChange } from "./subscription-bridge.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";
import { isClaudeCodeProvider } from "./claude-code/model.ts";
import { claudeCodeBackgroundAllowed } from "./claude-code/status.ts";

export function isSubscriptionProvider(provider: string | undefined): boolean { return provider === "chatgpt" || !!(provider && nativeSubscriptionId(provider)); }
export function subscriptionConnected(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTConnected();
	const native = nativeSubscriptionId(provider); return !!native && nativeSubscriptionConnected(native);
}
/** Ordinary API connections have no subscription background-consent gate.
 *  Claude Code has one (its settings switch) without being a leased
 *  subscription — its runs never ride the request cycle. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	if (provider === "chatgpt") return chatGPTBackgroundAllowed();
	if (isClaudeCodeProvider(provider)) return claudeCodeBackgroundAllowed();
	const native = provider ? nativeSubscriptionId(provider) : undefined;
	return native ? nativeSubscriptionBackgroundAllowed(native) : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean {
	if (provider === "chatgpt") return chatGPTScopeCurrent(scope);
	const native = nativeSubscriptionId(provider); return !!native && nativeAdmissionCurrent(native, scope);
}
export function onSubscriptionChange(listener: () => void): () => void {
	const stopChatGPT = onChatGPTChange(listener), stopNative = onNativeSubscriptionChange(listener);
	return () => { stopChatGPT(); stopNative(); };
}
