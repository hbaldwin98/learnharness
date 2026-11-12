# Learner Mermaid

A Core LearnHarness plugin (fork-owned) that lets learners answer with Mermaid diagrams.

- **Diagram button** on the practice answer, question answer and question thinking fields
  ([field accessory](../../docs/plugin-api/plugin-fields.md)): a menu of starters
  (flowchart, sequence, class, state, ER, C4 context/container) inserted as a
  ```` ```mermaid ```` fence at the caret, with the caret left on the diagram-type line.
- **Live preview** under those fields of the draft's mermaid fences (debounced, host rendering).
- **Enter inside a fence** inserts a newline instead of submitting; Ctrl/Cmd+Enter still submits.
- **Prompt guidance** for teacher, prober and practice agents: which Mermaid type fits which
  structure, the C4 size limit, how to read learner diagrams, and (practice) judging design answers
  by structure.

Learner and tutor ```` ```mermaid ```` fences are rendered by the host itself.
