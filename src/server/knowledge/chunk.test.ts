import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunk";

describe("chunkMarkdown", () => {
  it("prefixes each chunk with the title and its section heading", () => {
    const chunks = chunkMarkdown(
      "Refunds",
      "Intro paragraph.\n\n## Duplicate charges\n\nWe refund duplicates.\n\n## Timing\n\nFive days.",
    );
    expect(chunks.map((c) => c.content)).toEqual([
      "Refunds\n\nIntro paragraph.",
      "Refunds > Duplicate charges\n\nWe refund duplicates.",
      "Refunds > Timing\n\nFive days.",
    ]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("packs small paragraphs together and respects the size limit", () => {
    const paragraph = "word ".repeat(40).trim(); // ~200 chars
    const chunks = chunkMarkdown("T", Array(10).fill(paragraph).join("\n\n"), { maxChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(10);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(500);
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`);
    const chunks = chunkMarkdown("T", sentences.join(" "), { maxChars: 300 });
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(300);
      expect(chunk.content.trimEnd()).toMatch(/\.$/);
    }
    expect(chunks.map((c) => c.content.replace(/^T\n\n/, "")).join(" ")).toBe(sentences.join(" "));
  });

  it("hard-cuts text with no sentence breaks instead of producing an oversized chunk", () => {
    const chunks = chunkMarkdown("T", "x".repeat(2000), { maxChars: 400 });
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(400);
  });

  it("ignores empty sections and handles CRLF line endings", () => {
    const chunks = chunkMarkdown("T", "# Empty\r\n\r\n# Full\r\n\r\nBody text.");
    expect(chunks.map((c) => c.content)).toEqual(["T > Full\n\nBody text."]);
  });

  it("estimates tokens at roughly four characters each", () => {
    const [chunk] = chunkMarkdown("T", "abcd".repeat(25));
    expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.length / 4));
  });
});
