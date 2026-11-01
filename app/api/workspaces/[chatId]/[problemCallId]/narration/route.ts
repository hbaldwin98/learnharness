/**
 * POST /api/workspaces/:chatId/:problemCallId/narration — record one piece
 * of the learner's narration (typed or dictated) into the problem's trace
 * (docs/practice-workspaces-plan.md, step 5). Body: { text }. Returns every
 * recorded line. Nothing reaches the agent until the next Ask, Submit or
 * thinking message.
 */
import { appendNarration, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

export async function POST(req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
	let id = problemCallId;
	try {
		id = decodeURIComponent(problemCallId);
	} catch {
		// keep the raw segment
	}
	try {
		return Response.json({ narration: appendNarration(chatId, id, body?.text) });
	} catch (error) {
		if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}
