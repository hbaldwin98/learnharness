/**
 * GET  /api/workspaces/:chatId/:problemCallId/annotations — the agent's
 *      notes on the learner's code, live and outdated (plan step 7).
 * POST /api/workspaces/:chatId/:problemCallId/annotations — { dismiss: id }:
 *      the learner removes one.
 */
import { dismissAnnotation, workspaceAnnotations, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chatId: string; problemCallId: string }> };

async function ids(ctx: Params): Promise<{ chatId: string; id: string }> {
	const { chatId, problemCallId } = await ctx.params;
	try {
		return { chatId, id: decodeURIComponent(problemCallId) };
	} catch {
		return { chatId, id: problemCallId };
	}
}

function fail(error: unknown): Response {
	if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
	throw error;
}

export async function GET(_req: Request, ctx: Params): Promise<Response> {
	const { chatId, id } = await ids(ctx);
	try {
		return Response.json({ annotations: workspaceAnnotations(chatId, id) });
	} catch (error) {
		return fail(error);
	}
}

export async function POST(req: Request, ctx: Params): Promise<Response> {
	const { chatId, id } = await ids(ctx);
	const body = (await req.json().catch(() => null)) as { dismiss?: unknown } | null;
	try {
		return Response.json({ annotations: dismissAnnotation(chatId, id, body?.dismiss) });
	} catch (error) {
		return fail(error);
	}
}
