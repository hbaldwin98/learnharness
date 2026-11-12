import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WIDTH_STEPS, WIDTH_STORAGE_KEY, nextWidth, readWidth, writeWidth } from "../src/width.ts";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

describe("transcript width", () => {
  it("cycles 760 → 960 → 1160 → 1360 → 760", () => {
    assert.deepEqual(WIDTH_STEPS.map(s => s.px), [760, 960, 1160, 1360]);
    assert.equal(nextWidth("normal"), "wide");
    assert.equal(nextWidth("wide"), "wider");
    assert.equal(nextWidth("wider"), "widest");
    assert.equal(nextWidth("widest"), "normal");
  });
  it("reads a saved choice and ignores junk or a throwing store", () => {
    assert.equal(readWidth(memory({ [WIDTH_STORAGE_KEY]: "wider" })), "wider");
    assert.equal(readWidth(memory({ [WIDTH_STORAGE_KEY]: "huge" })), "normal");
    assert.equal(readWidth(undefined), "normal");
    assert.equal(readWidth({ getItem() { throw new Error("blocked"); }, setItem() {} }), "normal");
  });
  it("writes the choice and survives a throwing store", () => {
    const store = memory();
    writeWidth(store, "widest");
    assert.equal(store.map.get(WIDTH_STORAGE_KEY), "widest");
    assert.doesNotThrow(() => writeWidth({ getItem: () => null, setItem() { throw new Error("full"); } }, "wide"));
  });
});
