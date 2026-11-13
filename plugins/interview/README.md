# Interview

A LearnHarness Core plugin for **mock interviews**. Pick a topic, a style (narration,
coding, system design) and a length (15/30/45 min). The strong model writes the
interview once; a cheap interviewer model listens to your spoken answers and, each
time you pause, stays quiet, interjects, asks a follow-up, shows a multiple-choice
card, opens a code editor, moves on or wraps up. When the interview ends the strong
model writes a debrief, and **Teach me the gaps** starts a teaching session on them.

Requires this fork's plugin extension points: E4 (`app.createSession`) and E10
(dictation `onCommit`). It does not run on upstream LearnHarness.

## Where things live

- Open it from the sidebar **Interview** action. Interviews are listed on its start screen.
- **Settings → Interview**: silence before an answer is sent (0.5–5 s, default 1.5 s),
  **Wait until I submit**, and the interviewer model (default: the cheap slot, always at
  its lowest thinking level; applies to new interviews).
- Records: `<plugin data>/interviews/<id>.json` (script, position, debrief) and
  `settings.json`. The interviewer conversation is a host-managed plugin agent.
  Key points, probes, red flags and correct answers never reach the browser.
- Code-question drafts are kept per question in browser localStorage.

## Development

```sh
npm run sdk && npm ci   # or npm run plugins:setup from the repository root
npm run typecheck
npm test                # on Windows: node --import tsx --test tests/*.test.ts
npm run build
```

Replay harness: `npm run replay -- [fixture.json] --model <provider>:<id>` runs the
fixture's timed speech chunks through the same pause rule as the Live screen and each
resulting turn through the interviewer (same instructions and tools), printing every
decision. It talks to the provider directly through pi-ai with the API key from your
environment (it does not use the app's connections). Without `--model` it only prints
the turns the pause rule produces.
