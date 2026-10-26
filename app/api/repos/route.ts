/**
 * GET/POST /api/repos — the Open repo picker (src/server/repos.ts).
 *
 *   GET  → 200 {recent} — recently opened repos, newest first; folders that
 *          no longer exist are left out.
 *   POST {path} → 200 {repo} — the path resolved to an absolute, readable
 *          folder (`~` and relative paths anchor at the home directory),
 *          and moved to the front of the recent list. 400 {error} when it
 *          isn't one.
 */
import { listRecentRepos, rememberRepo, RepoPathError, resolveRepo } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ recent: listRecentRepos() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { path?: unknown };
	if (typeof body.path !== "string") return Response.json({ error: "path is required" }, { status: 400 });
	try {
		const repo = resolveRepo(body.path);
		rememberRepo(repo);
		return Response.json({ repo });
	} catch (err) {
		if (err instanceof RepoPathError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}
