/** Plugin-owned interview records: one file per interview at
 * <dataDirectory>/interviews/<id>.json, plus <dataDirectory>/settings.json.
 * Sync fs with a temp-file rename. A record stamped NEWER than this build is
 * refused on read and never rewritten. Backend only. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { InterviewDebrief, InterviewScript, InterviewSettings, InterviewSetup } from "./contract.ts";
import { sanitizeSettings } from "./settings.ts";

export const CURRENT_INTERVIEW_VERSION = 1;

export interface InterviewModel { provider: string; id: string; thinkingLevel?: string }

export interface InterviewRecord {
  version: number;
  id: string;
  setup: InterviewSetup;
  script: InterviewScript;
  /** The interviewer's model, fixed when the interview starts. */
  interviewerModel: InterviewModel;
  /** The managed agent conversation (ctx.agents) running the interviewer. */
  agentSessionId: string;
  /** The question the interviewer is on (absent = not started). */
  currentQuestionId?: string;
  /** Set by wrap_up or End interview. */
  endedAt?: string;
  debrief?: InterviewDebrief;
  createdAt: string;
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface InterviewStore {
  get(id: string): InterviewRecord | null;
  list(): InterviewRecord[];
  put(record: InterviewRecord): void;
  /** Read-modify-write (no awaits inside: atomic within the event loop). Null when unknown. */
  mutate(id: string, change: (record: InterviewRecord) => InterviewRecord): InterviewRecord | null;
  readSettings(): InterviewSettings;
  writeSettings(settings: InterviewSettings): void;
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"));
  fs.renameSync(tmp, file);
}

export function createStore(dataDirectory: string): InterviewStore {
  const dir = path.join(dataDirectory, "interviews");
  const settingsFile = path.join(dataDirectory, "settings.json");
  const fileOf = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid interview id: ${id}`);
    return path.join(dir, `${id}.json`);
  };
  const read = (id: string): InterviewRecord | null => {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(fileOf(id), "utf8")); } catch { return null; }
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as InterviewRecord;
    if (typeof record.version !== "number" || record.version > CURRENT_INTERVIEW_VERSION) return null;
    if (record.id !== id || !record.setup || !record.script || typeof record.agentSessionId !== "string") return null;
    return record;
  };
  const store: InterviewStore = {
    get: (id) => (SAFE_ID.test(id) ? read(id) : null),
    list() {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return []; }
      return names.filter((n) => n.endsWith(".json")).map((n) => read(n.slice(0, -5))).filter((r): r is InterviewRecord => r !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    put(record) { writeAtomic(fileOf(record.id), { ...record, version: CURRENT_INTERVIEW_VERSION }); },
    mutate(id, change) {
      const current = store.get(id);
      if (!current) return null;
      const next = { ...change(current), version: CURRENT_INTERVIEW_VERSION, id, updatedAt: new Date().toISOString() };
      writeAtomic(fileOf(id), next);
      return next;
    },
    readSettings() {
      try { return sanitizeSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8"))); } catch { return {}; }
    },
    writeSettings(settings) { writeAtomic(settingsFile, settings); },
  };
  return store;
}
