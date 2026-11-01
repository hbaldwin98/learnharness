/**
 * GET  /api/workspaces/docker — Docker's state and the coding images on this
 *      machine (Settings → Coding, plan step 8).
 * POST /api/workspaces/docker — { remove: "<image>" | "all" }: delete coding
 *      images; they rebuild on first use. Images a running problem uses are
 *      kept. Returns { removed, ...the new state }.
 */
import { codingDockerInfo, removeCodingImages, WorkspaceError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return Response.json(await codingDockerInfo());
}

export async function POST(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { remove?: unknown } | null;
	try {
		const removed = await removeCodingImages(body?.remove);
		return Response.json({ removed, ...(await codingDockerInfo()) });
	} catch (error) {
		if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}
