import { claudeCodeConnection } from "@/src/server";

/**
 * The Claude Code connection row (owner, 2026-10-28): CLI version, sign-in,
 * the transport + background switches (written through PUT
 * /api/settings/claudeCode) and the latest plan-limit reading.
 * `?recheck=1` re-probes the CLI instead of reading the minute-long cache.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const recheck = new URL(request.url).searchParams.get("recheck") === "1";
	return Response.json(await claudeCodeConnection(recheck), { headers: { "Cache-Control": "no-store" } });
}
