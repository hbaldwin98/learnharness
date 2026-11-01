/**
 * POST /api/workspaces/:chatId/:problemCallId/presence — the coding pane's
 * heartbeat (docs/practice-workspaces-plan.md, step 6): { visible } every
 * 20 s while the pane is open, and { visible: false } when it hides.
 * Listening runs only while the pane is present. Returns the pane's
 * listening indicator: { listening: "on" | "paused" | "off" }.
 */
import { workspacePresence, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

export async function POST(req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { visible?: unknown } | null;
	let id = problemCallId;
	try {
		id = decodeURIComponent(problemCallId);
	} catch {
		// keep the raw segment
	}
	try {
		return Response.json({ listening: await workspacePresence(chatId, id, body?.visible) });
	} catch (error) {
		if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}
