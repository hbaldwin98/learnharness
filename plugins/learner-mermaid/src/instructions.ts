/** Mermaid-specific guidance only. The host's shared formatting prompt already
 * introduces ```mermaid fences and quoted node labels; rich-code-blocks covers
 * SMILES/ABC/TikZ. Neither is repeated here. */
export const INSTRUCTIONS = [
  "Mermaid diagram types: pick the type that matches the structure.",
  "",
  "| The point is… | Mermaid type |",
  "|---|---|",
  "| control flow, an algorithm, a pipeline | `flowchart` |",
  "| an exchange over time — requests, auth handshakes, retries, async messages | `sequenceDiagram` |",
  "| types and their relations — interfaces, inheritance vs composition, a pattern | `classDiagram` |",
  "| a lifecycle or protocol — an order, a TCP connection, a circuit breaker | `stateDiagram-v2` |",
  "| a data model — entities, keys, cardinality | `erDiagram` |",
  "| a system's boundary and who talks to whom | `C4Context`, `C4Container` |",
  "| an infrastructure layout | `architecture-beta` |",
  "",
  "C4 uses a fixed layout: keep each view to about eight elements, and split a larger system into a context view and a container view rather than cramming one.",
  "",
  "The learner can draw too. Their thinking and answer fields have a diagram button that inserts Mermaid starters, and their ```mermaid fences render as diagrams. When drawing *is* the skill — a topology, a message sequence, a data model — ask for it in the wording (\"sketch the login flow as a sequence diagram\"). Read the learner's Mermaid as their answer: the structure — components, edges, direction, labels — is the content; a syntax slip is not a misunderstanding.",
].join("\n");

export const PRACTICE_INSTRUCTIONS = "**Design and diagram answers.** When a problem asks for a design or a diagram, the learner answers in a ```mermaid fence. Judge structure, not text: the components, the edges and their direction, what each edge carries, and the decision points the problem targets. Two diagrams with different layout or names can be the same answer. When several designs are valid, the modelSolution commits to the properties a correct answer must have and the trade-offs it must address, not to one diagram. Any design meeting them is right; a design that breaks one is wrong at that point, however clean it looks.";
