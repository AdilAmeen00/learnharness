"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeCodeConnectionDto, ClaudeCodePlanWindowDto } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsRow, ThinSelect, Toggle } from "./controls";

/**
 * Settings ▸ Providers ▸ Claude Code (owner, 2026-10-28): the local CLI's
 * sign-in, the one switch between `claude -p` and the Agent SDK, background
 * consent, and the plan's 5-hour / 7-day use from the latest run.
 */

export function claudeCodeStatusText(c: ClaudeCodeConnectionDto): string {
	if (!c.installed) return "Not installed. Install Claude Code, then sign in with your Claude subscription.";
	if (!c.loggedIn) return "Not signed in. Run `claude` in a terminal and sign in with your Claude subscription.";
	if (c.authMethod !== "claude.ai") return "Signed in with an API key. Sign in with your Claude subscription to use it here.";
	const plan = c.subscriptionType ? ` (${c.subscriptionType.charAt(0).toUpperCase()}${c.subscriptionType.slice(1)})` : "";
	return `${c.version ? `Claude Code ${c.version} · ` : ""}signed in${plan}`;
}

function resetText(window: ClaudeCodePlanWindowDto): string {
	if (window.resetsAt === undefined) return "";
	const at = new Date(window.resetsAt * 1000);
	const sameDay = at.toDateString() === new Date().toDateString();
	const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return ` (resets ${sameDay ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`})`;
}

export function claudeCodeLimitsText(limits: ClaudeCodeConnectionDto["limits"]): string {
	if (!limits || (!limits.fiveHour && !limits.sevenDay)) return "Shown after the first Claude Code run.";
	const part = (label: string, window: ClaudeCodePlanWindowDto | undefined) =>
		window ? `${label} ${Math.round(window.utilization * 100)}%${resetText(window)}` : null;
	return [part("5-hour", limits.fiveHour), part("7-day", limits.sevenDay)].filter(Boolean).join(" · ");
}

export function ClaudeCodeConnection() {
	const [connection, setConnection] = useState<ClaudeCodeConnectionDto | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);

	const load = useCallback(async (recheck = false) => {
		setBusy(true);
		try {
			const res = await fetch(`/api/claude-code${recheck ? "?recheck=1" : ""}`, { cache: "no-store" });
			if (!res.ok) throw new Error(String(res.status));
			const next = (await res.json()) as ClaudeCodeConnectionDto;
			if (!mounted.current) return;
			setConnection(next);
			setError(null);
			// The picker federates on connection: let it re-read.
			if (recheck) notifySettingsSaved("keys");
		} catch {
			if (mounted.current) setError("Claude Code's status could not be read. Try again.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	async function save(next: Pick<ClaudeCodeConnectionDto, "transport" | "allowBackgroundUse">) {
		if (!connection) return;
		const previous = connection;
		setConnection({ ...connection, ...next });
		try {
			const res = await fetch("/api/settings/claudeCode", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ transport: next.transport, allowBackgroundUse: next.allowBackgroundUse }),
			});
			if (!res.ok) throw new Error(String(res.status));
			setError(null);
		} catch {
			if (mounted.current) {
				setConnection(previous);
				setError("The setting could not be saved. Try again.");
			}
		}
	}

	return (
		<div className="flex flex-col gap-1" data-testid="claude-code-connection">
			<div className="flex flex-wrap items-center gap-3">
				<span className="font-ui text-xs text-foreground">Claude Code</span>
				<span className="min-w-0 flex-1 font-ui text-xs text-muted-foreground" data-testid="claude-code-status">
					{connection ? claudeCodeStatusText(connection) : "Checking…"}
				</span>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="cursor-pointer text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
					data-testid="claude-code-recheck"
					disabled={busy}
					onClick={() => void load(true)}
				>
					Recheck
				</Button>
			</div>
			{connection && (
				<>
					<SettingsRow label="Run through" hint="Both use your installed Claude Code and your subscription." testid="claude-code-transport-row">
						<ThinSelect
							value={connection.transport}
							ariaLabel="Run Claude Code through"
							testid="claude-code-transport"
							onChange={(value) => void save({ transport: value === "sdk" ? "sdk" : "cli", allowBackgroundUse: connection.allowBackgroundUse })}
						>
							<option value="cli">claude -p</option>
							<option value="sdk">Agent SDK</option>
						</ThinSelect>
					</SettingsRow>
					<SettingsRow
						label="Allow background use"
						hint="Graph extraction, research, demos and summaries on a Claude Code slot may use your plan."
						testid="claude-code-background-row"
					>
						<Toggle
							label="Allow Claude Code background use"
							checked={connection.allowBackgroundUse}
							onChange={(allowBackgroundUse) => void save({ transport: connection.transport, allowBackgroundUse })}
						/>
					</SettingsRow>
					<SettingsRow label="Plan limits" hint={claudeCodeLimitsText(connection.limits)} testid="claude-code-limits">
						<span />
					</SettingsRow>
				</>
			)}
			{error && (
				<p role="alert" className="text-xs text-red-400">
					{error}
				</p>
			)}
		</div>
	);
}
