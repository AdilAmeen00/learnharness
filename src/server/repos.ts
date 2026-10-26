/**
 * The Open repo button's server side: resolve a learner-supplied folder
 * path to a RepoRef, and keep the picker's recent list in
 * data/recent-repos.json (newest first, capped).
 *
 * Resolution mirrors the learner-file tools' anchor (agent/tools/
 * fs-shared.ts): `~` and relative paths resolve against the learner's
 * HOME, absolute paths stay. The folder must exist and be readable — the
 * agent reads it with the same read-only tools later; nothing here
 * reads file contents.
 */

import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { RECENT_REPOS_FILE } from "../../config.ts";
import type { RepoRef } from "../core/native-messages.ts";

/** How many recent repos the picker lists. */
export const RECENT_REPOS_MAX = 8;

/** A path that could not be resolved to a readable folder (the honest 400). */
export class RepoPathError extends Error {}

/** Resolve a typed or picked path to an absolute, readable directory. */
export function resolveRepo(raw: string): RepoRef {
	const input = raw.trim();
	if (!input) throw new RepoPathError("Enter a folder path.");
	const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
	const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(os.homedir(), expanded);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		throw new RepoPathError(`No folder at ${abs}`);
	}
	if (!stat.isDirectory()) throw new RepoPathError(`Not a folder: ${abs}`);
	try {
		fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK);
	} catch {
		throw new RepoPathError(`Folder is not readable: ${abs}`);
	}
	const trimmed = abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
	return { path: trimmed, name: path.basename(trimmed) || trimmed };
}

/** The recent list as stored (unvalidated shape is dropped, never thrown). */
function readRecentFile(): RepoRef[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(RECENT_REPOS_FILE, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(r): r is RepoRef => typeof r === "object" && r !== null && typeof r.path === "string" && typeof r.name === "string",
		);
	} catch {
		return []; // never saved / unreadable / corrupt → empty list
	}
}

/** Recent repos, newest first — folders that no longer resolve are skipped. */
export function listRecentRepos(): RepoRef[] {
	const out: RepoRef[] = [];
	for (const r of readRecentFile()) {
		try {
			out.push(resolveRepo(r.path));
		} catch {
			/* moved or deleted since — leave it out of the list */
		}
	}
	return out;
}

/** Move a repo to the front of the recent list. */
export function rememberRepo(repo: RepoRef): void {
	const next = [repo, ...readRecentFile().filter((r) => r.path !== repo.path)].slice(0, RECENT_REPOS_MAX);
	fs.mkdirSync(path.dirname(RECENT_REPOS_FILE), { recursive: true });
	fs.writeFileSync(RECENT_REPOS_FILE, JSON.stringify(next, null, "\t"), "utf-8");
}
