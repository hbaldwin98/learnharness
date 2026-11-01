/**
 * POST /api/workspaces/:chatId/:problemCallId/run — Run (visible tests) or
 * Submit (visible + hidden, hidden as counts) the SAVED files in the
 * problem's container (docs/practice-workspaces-plan.md, step 3). Body:
 * { mode: "run" | "submit" }. A Submit's result is stored for the
 * submission marker the following chat input appends.
 */
import { runWorkspace, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

export async function POST(req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
	const mode = body?.mode;
	if (mode !== "run" && mode !== "submit") return Response.json({ error: 'mode must be "run" or "submit"' }, { status: 400 });
	let id = problemCallId;
	try {
		id = decodeURIComponent(problemCallId);
	} catch {
		// keep the raw segment
	}
	try {
		return Response.json(await runWorkspace(chatId, id, mode, req.signal));
	} catch (error) {
		if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}
