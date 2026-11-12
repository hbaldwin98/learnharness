import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition, instructions, practiceInstructions, problemDefinition, readTests } from "./contract.ts";
import { runTests } from "./runner.ts";
import { runWithHook } from "./runner-hook.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const unregisterQuestion = ctx.registerQuestionType({
    ...definition,
    gradeAnswer(context) {
      if (typeof context.answer !== "string") throw new Error("Coding answers must be strings.");
      const tests = readTests(context.input.payload);
      const answer = context.answer;
      return runWithHook(
        { purpose: "grade", chatId: context.chatId, itemId: context.questionId, language: String((context.input.payload as { language?: unknown }).language ?? ""), answer, tests, signal: context.signal },
        () => runTests({ dataDirectory: ctx.dataDirectory, questionId: context.questionId, answer, tests, signal: context.signal }),
      );
    },
  });
  const unregisterProblem = ctx.registerProblemType({
    ...problemDefinition,
    processSubmission(context) {
      if (typeof context.submission !== "string") throw new Error("Coding submissions must be strings.");
      const tests = readTests(context.input.payload);
      const answer = context.submission;
      return runWithHook(
        { purpose: "submission", chatId: context.chatId, itemId: context.problemId, language: String((context.input.payload as { language?: unknown }).language ?? ""), answer, tests, signal: context.signal },
        () => runTests({ dataDirectory: ctx.dataDirectory, questionId: context.problemId, answer, tests, signal: context.signal }),
      );
    },
  });
  const unregisterPracticeInstructions = ctx.registerInstructions({ agents: ["practice"], text: practiceInstructions });
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: instructions });
  return () => {
    unregisterInstructions();
    unregisterPracticeInstructions();
    unregisterProblem();
    unregisterQuestion();
  };
}
