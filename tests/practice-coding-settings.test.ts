/**
 * PRACTICE CODING WORKSPACE — Settings → Coding (docs/practice-workspaces-plan.md,
 * step 8): the default language's validation and composition, and the
 * problem tool telling the agent the default.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { composeCodingLanguage, CODING_LANGUAGE_OPTIONS } from "../components/settings/coding-section.tsx";
import { CODE_LANGUAGES } from "../src/agent/workspaces/code/languages.ts";
import { problemTool } from "../src/agent/tools/practice.ts";

describe("the default coding language", () => {
	it("accepts the module's languages and clears on empty", () => {
		const ok = parseAgentSettingsBody({ codingLanguage: "rust" });
		assert.equal(ok.ok, true);
		assert.equal((ok as { settings: { codingLanguage?: string } }).settings.codingLanguage, "rust");
		assert.equal(parseAgentSettingsBody({ codingLanguage: "cobol" }).ok, false);
		const cleared = parseAgentSettingsBody({ codingLanguage: "" });
		assert.equal((cleared as { settings: { codingLanguage?: string } }).settings.codingLanguage, undefined);
	});

	it("resolves to null when unset", () => {
		assert.equal(resolveSettings(null).agent.codingLanguage, null);
		assert.equal(resolveSettings({ version: 1, agent: { codingLanguage: "go" } } as never).agent.codingLanguage, "go");
	});

	it("composes and offers exactly the module's languages", () => {
		assert.equal(composeCodingLanguage({}, "python").codingLanguage, "python");
		assert.equal("codingLanguage" in composeCodingLanguage({ codingLanguage: "python" }, ""), false);
		assert.deepEqual(CODING_LANGUAGE_OPTIONS.map((o) => o.id).sort(), [...CODE_LANGUAGES].sort());
	});

	it("reaches the agent through the problem tool's description", () => {
		const gate = { problemActive: false, needsPassingSubmit: false };
		const module = { id: "code", poseSchema: {}, verifyPose: async () => [] } as never;
		assert.match(problemTool(gate, undefined, [module], "c", "Rust").description, /default coding language is Rust/);
		assert.doesNotMatch(problemTool(gate, undefined, [module], "c").description, /default coding language/);
	});
});
