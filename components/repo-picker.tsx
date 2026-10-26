"use client";

import { useEffect, useRef, useState } from "react";
import { FolderGit2Icon } from "lucide-react";
import type { RepoRef } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";

/**
 * Open repo: attach a code repository to a teach session. The pill rides
 * the composer's action row (home, the new-session draft, and an open
 * teach session); the pick stays pending in the caller until the next
 * send carries it — the session's creation (POST /api/chats `repo`) or
 * the next text message (the text input's `repo`). The server writes a
 * repo-context marker the agent reads; the RepoContextCard below is the
 * learner's face of it.
 *
 * Picking: the desktop app opens the native folder dialog
 * (window.lh.pickFolder); a browser can't hand out a folder's real path,
 * so it gets a small popover — type a path (`~/Code/x`) or choose a recent
 * repo. Either way POST /api/repos resolves and remembers it.
 */

/** Resolve a path on the server (and move it to the front of recents). */
export async function resolveRepoPath(path: string, fetchLike: typeof fetch = fetch): Promise<RepoRef> {
	const res = await fetchLike("/api/repos", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	const body = (await res.json().catch(() => ({}))) as { repo?: RepoRef; error?: string };
	if (!res.ok || !body.repo) throw new Error(body.error ?? `Could not open ${path}`);
	return body.repo;
}

export function RepoPickerControl({
	repo,
	onPick,
	onClear,
	error,
}: {
	/** The pending (not yet sent) repo, or null. */
	repo: RepoRef | null;
	onPick: (repo: RepoRef) => void;
	onClear: () => void;
	/** A send that refused the pending repo (e.g. the folder moved since). */
	error?: string | null;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [nativeError, setNativeError] = useState<string | null>(null);

	const openPicker = async () => {
		setNativeError(null);
		const pickFolder = window.lh?.pickFolder;
		if (!pickFolder) {
			setOpen((v) => !v);
			return;
		}
		const chosen = await pickFolder().catch(() => null);
		if (!chosen) return; // cancelled
		try {
			onPick(await resolveRepoPath(chosen));
		} catch (err) {
			setNativeError((err as Error).message);
		}
	};

	// Outside click / Esc closes the popover. The body is portaled
	// (MenuShell), so its own clicks are carved out via [data-lh-menu].
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (rootRef.current && !rootRef.current.contains(t)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Claim the Esc: the window-level chain must not also abort a
				// turn or stop dictation under this popover.
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={rootRef} className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="repo-picker"
				onClick={() => void openPicker()}
				aria-expanded={open}
				title={repo ? repo.path : "Attach a code repository to learn from"}
				className={
					"flex max-w-[16rem] cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(repo
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<FolderGit2Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{repo ? repo.name : "Open repo"}</span>
			</button>
			{repo && (
				<button
					type="button"
					data-testid="repo-picker-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
			{(nativeError ?? error) && (
				<span data-testid="repo-picker-error" className="font-ui text-xs text-destructive">
					{nativeError ?? error}
				</span>
			)}
			{open && (
				<MenuShell
					anchorRef={rootRef}
					testid="repo-menu"
					preferredSide="up"
					align="left"
					menuClass="flex w-[24rem] flex-col gap-2 rounded-xl border bg-card p-3 text-xs shadow-xl"
				>
					<RepoPathForm
						onPicked={(r) => {
							setOpen(false);
							onPick(r);
						}}
					/>
				</MenuShell>
			)}
		</div>
	);
}

/** The browser's picker body: a path field plus the recent list. */
function RepoPathForm({ onPicked }: { onPicked: (repo: RepoRef) => void }) {
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [recent, setRecent] = useState<RepoRef[] | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		let live = true;
		void fetch("/api/repos")
			.then((r) => r.json() as Promise<{ recent?: RepoRef[] }>)
			.then((b) => {
				if (live) setRecent(b.recent ?? []);
			})
			.catch(() => {
				if (live) setRecent([]);
			});
		return () => {
			live = false;
		};
	}, []);

	const submit = async (target: string) => {
		if (!target.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			onPicked(await resolveRepoPath(target));
		} catch (err) {
			setError((err as Error).message);
			setBusy(false);
		}
	};

	return (
		<>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit(path);
				}}
				className="flex items-center gap-2"
			>
				<input
					ref={inputRef}
					data-testid="repo-path-input"
					value={path}
					onChange={(e) => setPath(e.target.value)}
					placeholder="~/Code/my-repo"
					spellCheck={false}
					aria-invalid={error !== null}
					className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 font-mono text-xs outline-none focus-visible:border-ring aria-invalid:border-destructive"
				/>
				<button
					type="submit"
					data-testid="repo-path-open"
					disabled={busy || !path.trim()}
					className="h-8 cursor-pointer rounded-md border border-border px-3 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
				>
					Open
				</button>
			</form>
			{error && (
				<div data-testid="repo-path-error" className="text-destructive">
					{error}
				</div>
			)}
			{recent && recent.length > 0 && (
				<div className="flex flex-col gap-0.5">
					<div className="px-1 pt-1 font-ui text-[11px] text-muted-foreground uppercase">Recent</div>
					{recent.map((r) => (
						<button
							key={r.path}
							type="button"
							data-testid="repo-recent"
							onClick={() => void submit(r.path)}
							className="flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
						>
							<span className="shrink-0 text-foreground">{r.name}</span>
							<span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{r.path}</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}

/** The repo-context marker's details (native-messages.ts RepoRef). */
export type RepoContextData = RepoRef;

/** The transcript's face of an attached repo: one quiet line where it
 *  was attached (scaffolding like the graph-context card, not a turn). */
export function RepoContextCard({ data }: { data: RepoContextData }) {
	return (
		<div
			data-testid="repo-context-card"
			title={data?.path}
			className="my-1 flex items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground"
		>
			<FolderGit2Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="font-medium">Repo</span>
			<span className="text-foreground/80">{data?.name}</span>
			<span className="min-w-0 flex-1 truncate font-mono text-[11px]">{data?.path}</span>
		</div>
	);
}
