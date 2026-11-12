import assert from "node:assert/strict";
import test from "node:test";
import { notifyCommit } from "../components/plugin-composer.tsx";

test("dictation commits notify once per chunk with a timestamp; failures are reported, not thrown", () => {
	const seen: [string, number][] = [], errors: unknown[] = [];
	const before = Date.now();
	notifyCommit((text, at) => { seen.push([text, at]); }, "hello", error => errors.push(error));
	assert.equal(seen.length, 1);
	assert.equal(seen[0]![0], "hello");
	assert.ok(seen[0]![1] >= before && seen[0]![1] <= Date.now());
	notifyCommit(() => { throw new Error("boom"); }, "x", error => errors.push(error));
	assert.equal((errors[0] as Error).message, "boom");
	notifyCommit(undefined, "x", error => errors.push(error));
	assert.equal(errors.length, 1);
});
