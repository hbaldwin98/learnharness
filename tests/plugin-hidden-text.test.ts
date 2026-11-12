import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createPluginHost } from "../src/server/plugin-host.ts";
import { hiddenTurnTextIds, markHidesTurnText, PLUGIN_HIDES_TURN_TEXT_KEY, validateHidesTurnText } from "../src/core/plugin-hidden-text.ts";
import { projectView } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PluginInference, PluginLearningData } from "../src/core/plugins.ts";
import type { PluginAgentService } from "../src/core/plugin-agents.ts";
import type { PluginWorkerService } from "../src/core/plugin-workers.ts";

const assistant = (id: string, content: unknown[]) => ({ id, role: "assistant", content, stopReason: "toolUse", timestamp: 1 }) as unknown as LhMessage;
const result = (id: string, callId: string, details: unknown, isError = false) => ({ id, role: "toolResult", toolCallId: callId, toolName: "run_code", content: [], details, isError, timestamp: 1 }) as unknown as LhMessage;
const user = (id: string) => ({ id, role: "user", content: "go", timestamp: 1 }) as LhMessage;
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string) => ({ type: "toolCall", id, name: "run_code", arguments: {} });

test("flagging keeps object details and leaves non-object details unflagged", () => {
	assert.deepEqual(markHidesTurnText({ content: [], details: { a: 1 } }).details, { a: 1, [PLUGIN_HIDES_TURN_TEXT_KEY]: true });
	assert.deepEqual(markHidesTurnText({ content: [], details: undefined }).details, { [PLUGIN_HIDES_TURN_TEXT_KEY]: true });
	assert.deepEqual(markHidesTurnText({ content: [], details: [1] }).details, [1]);
	assert.throws(() => validateHidesTurnText(["bad name"]), /native tool names/);
	assert.equal(validateHidesTurnText(undefined), undefined);
});

test("a successful flagged call hides its message's text and the next text-only message, for presentation only", () => {
	const flag = { [PLUGIN_HIDES_TURN_TEXT_KEY]: true };
	const messages = [
		user("u1"),
		assistant("a1", [text("running…"), { type: "thinking", thinking: "plan" }, call("c1")]),
		result("r1", "c1", flag),
		assistant("a2", [text("Here is the output")]),
		assistant("a3", [text("still shown")]),
		user("u2"),
		assistant("b1", [text("shown"), call("c2")]),
		result("r2", "c2", flag, true),
		assistant("b2", [text("also shown")]),
	];
	assert.deepEqual([...hiddenTurnTextIds(messages)], ["a1", "a2"]);
	const view = projectView(messages);
	const texts = view.flatMap(m => m.parts.filter(p => p.type === "text").map(p => p.text));
	assert.ok(!texts.includes("running…") && !texts.includes("Here is the output"));
	for (const shown of ["still shown", "shown", "also shown"]) assert.ok(texts.includes(shown), shown);
	assert.ok(view.some(m => m.parts.some(p => p.type === "reasoning" && p.text === "plan")));
	// A following message that itself calls a tool is not text-only.
	assert.deepEqual([...hiddenTurnTextIds([assistant("x", [call("c1")]), result("r", "c1", flag), assistant("y", [text("t"), call("c3")])])], ["x"]);
});

test("registered hidesTurnText flags only the listed tools' successful results", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hidden-text-"));
	const directory = path.join(root, "plugins"); fs.mkdirSync(directory);
	const host = createPluginHost({ directory, appVersion: "0.3.7", createServices: () => ({
		learning: {} as PluginLearningData, inference: {} as PluginInference,
		agents: { dispose: async () => {} } as PluginAgentService, workers: { dispose: async () => {} } as PluginWorkerService,
		createBackgroundTool() { throw new Error("unexpected"); },
	}) });
	t.after(async () => { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
	const dir = path.join(directory, "example", "dist"); fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ apiVersion: 1, id: "example", name: "example", version: "1.0.0", minAppVersion: "0.3.0", backend: "backend.cjs" }));
	fs.writeFileSync(path.join(dir, "backend.cjs"), `exports.activate = ctx => {
		const tool = name => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: { name } }) });
		ctx.handle("bad", () => { try { ctx.registerTools({ agents: ["teacher"], hidesTurnText: ["no spaces"], create: () => [] }); return "accepted"; } catch (e) { return e.message; } });
		ctx.registerTools({ agents: ["teacher"], hidesTurnText: ["quiet_tool"], create: () => [tool("quiet_tool"), tool("loud_tool")] });
	};`);
	await host.initialize(); await host.setEnabled("example", true);
	assert.match(String(await host.call("example", "bad")), /native tool names/);
	const tools = host.agentContributions({ chatId: "c", agent: "teacher" }, []).tools;
	const quiet = tools.find(tool => tool.name === "quiet_tool")!, loud = tools.find(tool => tool.name === "loud_tool")!;
	assert.deepEqual((await quiet.execute("1", {})).details, { name: "quiet_tool", [PLUGIN_HIDES_TURN_TEXT_KEY]: true });
	assert.deepEqual((await loud.execute("2", {})).details, { name: "loud_tool" });
});
