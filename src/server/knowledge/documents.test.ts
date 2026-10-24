import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, documentTitle, readUpload } from "./documents";

const upload = (name: string, text: string, size = Buffer.byteLength(text)) => ({
  name,
  size,
  text: async () => text,
});

describe("readUpload", () => {
  it("accepts markdown and text files and strips a byte-order mark", async () => {
    const md = await readUpload(upload("Refunds.MD", "\uFEFF# Refunds\n\nBody"));
    expect(md).toMatchObject({ mimeType: "text/markdown", text: "# Refunds\n\nBody" });
    expect((await readUpload(upload("notes.txt", "plain"))).mimeType).toBe("text/plain");
  });

  it.each([
    [upload("guide.pdf", "x"), /Only .md/],
    [upload("empty.md", ""), /empty/],
    [upload("big.md", "x", MAX_DOCUMENT_BYTES + 1), /900 KB/],
    [upload("blank.md", "   \n  "), /no text/],
    [upload("binary.md", "PNG\u0000\u0000data"), /UTF-8/],
  ])("rejects %o", async (file, message) => {
    await expect(readUpload(file)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    });
  });
});

describe("documentTitle", () => {
  it("uses the first # heading, else the file name", () => {
    expect(documentTitle("x.md", "intro\n# Refund policy\n## Details")).toBe("Refund policy");
    expect(documentTitle("refund_policy-v2.md", "no heading here")).toBe("refund policy v2");
  });
});
