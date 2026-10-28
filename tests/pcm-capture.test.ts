import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import { runInNewContext } from "node:vm";

/** Load the real worklet file with a stub AudioWorklet global scope. */
function loadProcessor() {
	const posted: Array<{ msg: { type: string; buffer?: unknown }; transfer?: unknown[] }> = [];
	let Processor: (new () => { process: (inputs: Float32Array[][]) => boolean }) | undefined;
	class AudioWorkletProcessor {
		port = { postMessage: (msg: { type: string }, transfer?: unknown[]) => posted.push({ msg, transfer }) };
	}
	runInNewContext(readFileSync(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8"), {
		AudioWorkletProcessor,
		registerProcessor: (_name: string, cls: typeof Processor) => { Processor = cls; },
	});
	return { processor: new Processor!(), posted };
}

describe("pcm-capture worklet", () => {
	it("posts audio as an ArrayBuffer, not a typed-array view", () => {
		const { processor, posted } = loadProcessor();
		// 16 render quanta of 128 samples = one 2048-sample frame.
		for (let i = 0; i < 16; i++) processor.process([[new Float32Array(128).fill(0.5)]]);
		const audio = posted.filter((p) => p.msg.type === "audio");
		assert.equal(audio.length, 1);
		const { buffer } = audio[0]!.msg;
		// isArrayBuffer, not instanceof: the buffer comes from the vm's realm.
		assert.ok(types.isArrayBuffer(buffer), "a typed-array view is not transferable");
		assert.equal((buffer as ArrayBuffer).byteLength, 2048 * 2);
		assert.equal(audio[0]!.transfer?.length, 1);
		assert.equal(audio[0]!.transfer![0], buffer, "the frame's buffer is transferred, not copied");
	});
});
