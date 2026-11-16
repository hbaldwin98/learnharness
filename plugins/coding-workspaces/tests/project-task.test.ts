import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTaskPayload } from "../src/server/project-task.ts";

describe("project task payload", () => {
	it("accepts a command with relative hidden test files", () => {
		assert.deepEqual(validateTaskPayload({ tests: { command: "pytest -q $LH_TESTS", files: [{ path: "test_app.py", content: "def test(): pass" }] } }), []);
	});
	it("rejects blank commands and escaping or absolute test paths", () => {
		const errors = validateTaskPayload({ tests: { command: "  ", files: [{ path: "../x.py", content: "" }, { path: "/abs.py", content: "" }, { path: "C:/w.py", content: "" }] } });
		assert.equal(errors.length, 4);
		assert.match(errors[0]!, /blank/);
	});
	it("caps the number and size of test files", () => {
		const many = Array.from({ length: 21 }, (_, i) => ({ path: `t${i}.py`, content: "" }));
		assert.match(validateTaskPayload({ tests: { command: "x", files: many } }).join(), /at most 20/);
		assert.match(validateTaskPayload({ tests: { command: "x", files: [{ path: "big", content: "x".repeat(300_000) }] } }).join(), /too large/);
	});
});
