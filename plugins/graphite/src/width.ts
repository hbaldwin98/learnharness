/** Transcript width steps. The CSS maps the root attribute to a max-width;
 *  only the transcript widens, the composer dock keeps its width. */
export const WIDTH_STEPS = [
  { id: "normal", label: "Normal", px: 760 },
  { id: "wide", label: "Wide", px: 960 },
  { id: "wider", label: "Wider", px: 1160 },
  { id: "widest", label: "Widest", px: 1360 },
] as const;

export type TranscriptWidth = (typeof WIDTH_STEPS)[number]["id"];

/** Same key the pre-plugin chip used, so a saved choice carries over. */
export const WIDTH_STORAGE_KEY = "lh.transcriptWidth";
/** Root attribute graphite.css reads. */
export const WIDTH_ATTRIBUTE = "data-lh-transcript-width";

export function isTranscriptWidth(value: unknown): value is TranscriptWidth {
  return WIDTH_STEPS.some(step => step.id === value);
}

export function nextWidth(current: TranscriptWidth): TranscriptWidth {
  const index = WIDTH_STEPS.findIndex(step => step.id === current);
  return WIDTH_STEPS[(index + 1) % WIDTH_STEPS.length]!.id;
}

export interface WidthStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readWidth(storage: WidthStorage | undefined): TranscriptWidth {
  try {
    const saved = storage?.getItem(WIDTH_STORAGE_KEY);
    return isTranscriptWidth(saved) ? saved : "normal";
  } catch { return "normal"; }
}

export function writeWidth(storage: WidthStorage | undefined, width: TranscriptWidth): void {
  try { storage?.setItem(WIDTH_STORAGE_KEY, width); } catch { /* private window: session-only */ }
}
