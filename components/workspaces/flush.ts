"use client";

/**
 * The workspace autosave flush (practice workspaces, plan step 3): the
 * server reads the learner's files from its own store for Run, Submit and
 * the thinking snapshot, so anything that reads them first awaits the
 * mounted workspace's pending save. One registration per problem; none
 * mounted = nothing pending.
 */

const flushers = new Map<string, () => Promise<void>>();

export function registerWorkspaceFlush(problemCallId: string, flush: () => Promise<void>): () => void {
	flushers.set(problemCallId, flush);
	return () => {
		if (flushers.get(problemCallId) === flush) flushers.delete(problemCallId);
	};
}

/** Await the problem's pending save (resolves at once when none). */
export async function flushWorkspace(problemCallId: string): Promise<void> {
	await flushers.get(problemCallId)?.().catch(() => {});
}
