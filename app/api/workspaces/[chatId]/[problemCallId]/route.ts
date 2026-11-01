/**
 * GET/PUT /api/workspaces/:chatId/:problemCallId — a practice coding
 * workspace (docs/practice-workspaces-plan.md, step 3). GET loads the
 * learner's files (the saved ones, else the starter), the read-only
 * visible tests and the last results; PUT saves the files (contents of the
 * starter files only). The client never sends tests or results.
 */
import { loadWorkspace, saveWorkspace, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

const decode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

function errorResponse(error: unknown): Response {
	if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
	throw error;
}

export async function GET(_req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	try {
		return Response.json(loadWorkspace(chatId, decode(problemCallId)));
	} catch (error) {
		return errorResponse(error);
	}
}

export async function PUT(req: Request, ctx: Params): Promise<Response> {
	const { chatId, problemCallId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { files?: unknown } | null;
	try {
		saveWorkspace(chatId, decode(problemCallId), body?.files);
		return Response.json({ ok: true });
	} catch (error) {
		return errorResponse(error);
	}
}
