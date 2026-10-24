import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, documentTitle, readUpload } from "./documents";
import { htmlToMarkdown } from "./extract";

const upload = (name: string, content: string | Uint8Array, size?: number) => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name,
    size: size ?? bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
};

/** Tiny hand-built files from tests/fixtures (see their contents in the assertions below). */
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

describe("readUpload", () => {
  it("accepts markdown and text files and strips a byte-order mark", async () => {
    const md = await readUpload(upload("Refunds.MD", "﻿# Refunds\n\nBody"));
    expect(md).toMatchObject({ mimeType: "text/markdown", text: "# Refunds\n\nBody" });
    expect((await readUpload(upload("notes.txt", "plain"))).mimeType).toBe("text/plain");
  });

  it("extracts the text of every PDF page", async () => {
    const pdf = await readUpload(upload("refund-policy.pdf", fixture("refund-policy.pdf")));
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.text).toContain("Annual plans can be refunded within 30 days of purchase.");
    expect(pdf.text).toContain("A duplicate charge is refunded automatically within 5 days.");
    // Pages are separated so the chunker can split them.
    expect(pdf.text).toMatch(/purchase\.\n\nDuplicate charges/);
  });

  it("turns Word headings into markdown headings", async () => {
    const docx = await readUpload(upload("Refund Policy.docx", fixture("refund-policy.docx")));
    expect(docx.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.text).toBe(
      "# Refund policy\n\nAnnual plans can be refunded within 30 days of purchase.\n\n" +
        "## Duplicate charges\n\nA duplicate charge is refunded automatically within 5 days & you get an email.",
    );
    expect(documentTitle("Refund Policy.docx", docx.text)).toBe("Refund policy");
  });

  it.each([
    [upload("guide.pptx", "x"), /\.md, \.txt, \.pdf or \.docx/],
    [upload("empty.md", ""), /empty/],
    [upload("big.md", "x", MAX_DOCUMENT_BYTES + 1), /4 MB/],
    [upload("blank.md", "   \n  "), /no text/],
    [upload("binary.md", "PNG\u0000\u0000data"), /UTF-8/],
    // Content must match the extension, whatever the file is called.
    [upload("renamed.pdf", "# Not a PDF"), /not a PDF/],
    [upload("renamed.docx", "# Not a zip"), /not a Word/],
    [upload("broken.pdf", "%PDF-1.4\ngarbage"), /could not be read/],
    [upload("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), /could not be read/],
  ])("rejects %o", async (file, message) => {
    await expect(readUpload(file)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(message),
    });
  });
});

describe("htmlToMarkdown", () => {
  it("keeps headings, paragraphs and list items, and drops other markup", () => {
    expect(
      htmlToMarkdown(
        '<h2>Steps</h2><ol><li>Open <a href="x">billing</a></li><li>Click &quot;Refund&quot;</li></ol><p>Done<img src=""/></p>',
      ),
    ).toBe('## Steps\n\n- Open billing\n- Click "Refund"\n\nDone');
  });
});

describe("documentTitle", () => {
  it("uses the first # heading, else the file name", () => {
    expect(documentTitle("x.md", "intro\n# Refund policy\n## Details")).toBe("Refund policy");
    expect(documentTitle("refund_policy-v2.md", "no heading here")).toBe("refund policy v2");
  });
});
