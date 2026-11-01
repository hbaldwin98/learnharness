/**
 * GET /api/workspaces/:chatId/:problemCallId/diagnostics — the problem's
 * latest language-server errors and warnings per file, plus the server's
 * status (docs/practice-workspaces-plan.md, step 4). The pane refetches
 * on the bus's workspace-diagnostics event.
 */
import { workspaceDiagnostics, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

export async function GET(_req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	let id = problemCallId;
	try {
		id = decodeURIComponent(problemCallId);
	} catch {
		// keep the raw segment
	}
	try {
		return Response.json(workspaceDiagnostics(chatId, id));
	} catch (error) {
		if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}
