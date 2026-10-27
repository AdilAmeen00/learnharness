"use client";
/**
 * The Keyboard section (thin settings wave): view / rebind / reset over
 * core/keyboard.ts's registry. The overrides persist in localStorage
 * (lh:keymap, overrides-only, merged over DEFAULT_BINDINGS), so rebinding
 * is INSTANT — the dispatcher reads the map per keydown, no reload.
 *
 * Rebind flow: click Rebind → the row listens for the next keydown
 * (capture phase, preventDefault — nothing types anywhere), eventBinding
 * normalizes it, saveOverrides persists. Escape cancels. displayOnly
 * actions (a surface owns those keys — the question dock's row machine)
 * are listed for reading but never rebindable.
 *
 * Thin: no conflict detection — if a new binding collides with another
 * action's, the first match in registry order wins; the cheat sheet shows
 * both. Detection belongs to the designed wave.
 */

import { useEffect, useState } from "react";
import {
	CARET_DELAY_MAX_MS,
	CARET_SPEED_STEPS,
	DEFAULT_CARET_DELAY_MS,
	DEFAULT_CARET_SPEED,
	KEYBOARD_ACTIONS,
	eventBinding,
	formatBinding,
	loadCaretPrefs,
	loadOverrides,
	saveCaretPrefs,
	saveOverrides,
	type CaretPrefs,
	type KeyAction,
	type KeyScope,
} from "@/src/core";
import { SettingsRow } from "./controls.tsx";

const SCOPES: { scope: KeyScope; label: string }[] = [
	{ scope: "global", label: "Global" },
	{ scope: "chat", label: "Chat" },
	{ scope: "reading", label: "Reading" },
	{ scope: "graph", label: "Graph" },
];

/** The reading caret's hold speed + repeat delay (owner, 2026-10-27):
 *  stored on this device (lh:caret) like the keymap; - / = step the same
 *  speed live while reading. */
function CaretSpeedRows() {
	const [prefs, setPrefs] = useState<CaretPrefs>({ speed: DEFAULT_CARET_SPEED, delayMs: DEFAULT_CARET_DELAY_MS });
	useEffect(() => setPrefs(loadCaretPrefs()), []);
	const update = (next: CaretPrefs) => {
		saveCaretPrefs(next);
		setPrefs(next);
	};
	const speedIndex = CARET_SPEED_STEPS.indexOf(prefs.speed as (typeof CARET_SPEED_STEPS)[number]);
	const slider = "h-1 w-32 cursor-pointer accent-foreground";
	return (
		<>
			<SettingsRow label="Caret hold speed" hint="- / = change it while reading" testid="kbd-caret-speed">
				<span className="flex items-center gap-2">
					<input
						type="range"
						aria-label="Caret hold speed"
						min={0}
						max={CARET_SPEED_STEPS.length - 1}
						step={1}
						value={speedIndex < 0 ? CARET_SPEED_STEPS.indexOf(DEFAULT_CARET_SPEED as never) : speedIndex}
						onChange={(e) => update({ ...prefs, speed: CARET_SPEED_STEPS[Number(e.target.value)]! })}
						className={slider}
					/>
					<span className="w-12 text-right font-ui text-xs tabular-nums text-muted-foreground">{prefs.speed} /s</span>
				</span>
			</SettingsRow>
			<SettingsRow label="Caret repeat delay" hint="Wait before a held key starts repeating" testid="kbd-caret-delay">
				<span className="flex items-center gap-2">
					<input
						type="range"
						aria-label="Caret repeat delay"
						min={0}
						max={CARET_DELAY_MAX_MS}
						step={10}
						value={prefs.delayMs}
						onChange={(e) => update({ ...prefs, delayMs: Number(e.target.value) })}
						className={slider}
					/>
					<span className="w-12 text-right font-ui text-xs tabular-nums text-muted-foreground">{prefs.delayMs} ms</span>
				</span>
			</SettingsRow>
		</>
	);
}

/** The overrides map after ONE change (pure — exported for tests):
 *  binding null = reset the action to its default (key removed). */
export function nextOverrides(
	current: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string | null,
): Partial<Record<KeyAction, string>> {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}

export function KeyboardSection() {
	const [overrides, setOverrides] = useState<Partial<Record<KeyAction, string>>>({});
	const [rebinding, setRebinding] = useState<KeyAction | null>(null);
	const [nonce, setNonce] = useState(0);

	// localStorage is read post-mount (SSR-safe); `nonce` re-reads after writes.
	useEffect(() => {
		setOverrides(loadOverrides());
	}, [nonce]);

	// The capture listener — only while a rebind is armed.
	useEffect(() => {
		if (!rebinding) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRebinding(null);
				return;
			}
			// Modifier keydowns arrive one by one (⌘ down, then ⇧, then the
			// key) — each is a keydown this capture listener sees. They are
			// not bindings; keep listening for the real key.
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			const binding = eventBinding(e);
			if (!binding) return;
			const next = nextOverrides(loadOverrides(), rebinding, binding);
			saveOverrides(next);
			setRebinding(null);
			setNonce((n) => n + 1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rebinding]);

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		setNonce((n) => n + 1);
	}

	function resetAll() {
		saveOverrides({});
		setNonce((n) => n + 1);
	}

	const overridden = (id: KeyAction) => overrides[id] !== undefined;

	return (
		<>
			{SCOPES.map(({ scope, label }) => {
				const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
				if (!actions.length) return null;
				return (
					<div key={scope} data-testid={`kbd-scope-${scope}`}>
						<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{label}</p>
						<div className="flex flex-col gap-2">
							{actions.map((def) => {
								const effective = overrides[def.id] ?? def.binding;
								return (
									<SettingsRow
										key={def.id}
										label={def.label}
										hint={
											def.displayOnly
												? def.scope === "reading"
													? "Fixed — vim motion"
													: "Fixed — part of this screen"
												: undefined
										}
										testid={`kbd-row-${def.id}`}
									>
										<span className="flex items-center gap-2">
											<kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">
												{rebinding === def.id ? "Press keys…" : (def.display ?? formatBinding(effective))}
											</kbd>
											{def.displayOnly ? null : rebinding === def.id ? (
												<button
													type="button"
													onClick={() => setRebinding(null)}
													className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
												>
													Cancel
												</button>
											) : (
												<>
													<button
														type="button"
														onClick={() => setRebinding(def.id)}
														data-testid={`kbd-rebind-${def.id}`}
														className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
													>
														Rebind
													</button>
													{overridden(def.id) && (
														<button
															type="button"
															onClick={() => resetOne(def.id)}
															data-testid={`kbd-reset-${def.id}`}
															className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
														>
															Reset
														</button>
													)}
												</>
											)}
										</span>
									</SettingsRow>
								);
							})}
							{scope === "reading" && <CaretSpeedRows />}
						</div>
					</div>
				);
			})}
			<div className="mt-1 flex items-center justify-between">
				<span className="text-xs text-muted-foreground/70">Stored on this device (lh:keymap) — overrides only.</span>
				<button
					type="button"
					onClick={resetAll}
					data-testid="kbd-reset-all"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Reset all to defaults
				</button>
			</div>
		</>
	);
}