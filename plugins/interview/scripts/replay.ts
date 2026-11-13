/** Replay an interview fixture through the pause rule and (optionally) a real
 * interviewer model. Development only; talks to the provider directly through
 * pi-ai with the API key from your environment.
 *
 *   npm run replay -- [fixture.json] [--model <provider>:<id>] [--thinking <level>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { runReplay, turnsFromChunks, type ReplayFixture } from "../src/replay.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const consumed = new Set([option("--model"), option("--thinking")]);
const fixturePath = args.find((a) => !a.startsWith("--") && !consumed.has(a)) ?? path.join(import.meta.dirname, "../tests/fixtures/narration-web-request.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ReplayFixture;

const turns = turnsFromChunks(fixture.chunks, fixture.listening);
console.log(`Fixture: ${fixture.name}`);
console.log(`${fixture.chunks.length} chunks → ${turns.length} turns (silence ${fixture.listening.silenceMs} ms${fixture.listening.waitForSubmit ? ", wait for submit" : ""})\n`);

const spec = option("--model");
if (!spec) {
  for (const turn of turns) console.log(`YOU: ${turn}\n`);
  process.exit(0);
}
if (!fixture.script) {
  console.error("The fixture has no script; add one to replay against a model.");
  process.exit(1);
}
const [provider, ...rest] = spec.split(":");
const model = getModel(provider as never, rest.join(":") as never);
if (!model) {
  console.error(`Unknown model ${spec}`);
  process.exit(1);
}
const thinking = option("--thinking");
const { decisions } = await runReplay({
  setup: fixture.setup, script: fixture.script, turns,
  engine: { model, streamFn: streamSimple as never, ...(thinking ? { thinkingLevel: thinking } : {}) },
});
for (const d of decisions) {
  console.log(`YOU: ${d.turn}`);
  const detail = d.details as { text?: string; prompt?: string; questionId?: string } | null;
  const said = detail?.text ?? detail?.prompt ?? "";
  console.log(`  → ${d.tool ?? "(no tool)"}${detail?.questionId ? ` [${detail.questionId}]` : ""}${said ? `: ${said}` : ""}\n`);
}
