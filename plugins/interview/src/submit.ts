/** One structured strong-model call through ctx.inference: the model must call a
 * single submit tool; its arguments are schema-checked, then rule-checked, and a
 * violation goes back as a tool error for another attempt (at most `maxAttempts`). */
import type { AssistantMessage, Context, Message, Tool } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export type Complete = (context: Context) => Promise<AssistantMessage>;

export interface SubmitCall<In, Out> {
  complete: Complete;
  systemPrompt: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  parameters: TSchema;
  /** Shape the validated arguments into the result. */
  fill: (input: In) => Out;
  /** The rules a schema can't express; null = valid. */
  validate: (value: Out) => string | null;
  maxAttempts?: number;
  neverSubmitted: string;
}

export async function submitCall<In, Out>(call: SubmitCall<In, Out>): Promise<Out> {
  const tool: Tool = { name: call.toolName, description: call.toolDescription, parameters: call.parameters };
  const messages: Message[] = [{ role: "user", content: call.prompt, timestamp: Date.now() }];
  const attempts = call.maxAttempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reply = await call.complete({ systemPrompt: call.systemPrompt, messages, tools: [tool] });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? `The model request ended: ${reply.stopReason}`);
    }
    messages.push(reply);
    const calls = reply.content.filter((c) => c.type === "toolCall");
    if (!calls.length) {
      messages.push({ role: "user", content: `Submit with the ${call.toolName} tool.`, timestamp: Date.now() });
      continue;
    }
    let accepted: Out | undefined;
    for (const c of calls) {
      let problem: string | null;
      if (c.name !== call.toolName) problem = `Unknown tool ${c.name}; use ${call.toolName}.`;
      else if (accepted !== undefined) problem = "Already submitted.";
      else if (!Value.Check(call.parameters, c.arguments)) {
        const first = [...Value.Errors(call.parameters, c.arguments)][0];
        problem = `Invalid input${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}.`;
      } else {
        const value = call.fill(c.arguments as In);
        problem = call.validate(value);
        if (!problem) accepted = value;
      }
      messages.push({
        role: "toolResult", toolCallId: c.id, toolName: c.name, isError: problem !== null,
        content: [{ type: "text", text: problem ?? "Submitted." }], timestamp: Date.now(),
      });
    }
    if (accepted !== undefined) return accepted;
  }
  throw new Error(call.neverSubmitted);
}
