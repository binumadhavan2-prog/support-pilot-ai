import { AppError } from "@/lib/errors";

/*
 * Text extraction for binary uploads. PDFs go through unpdf (pdf.js, no native code); Word files
 * through mammoth, converted to markdown-style headings so the section chunker still has structure.
 * Both parsers load lazily, so a text upload never pays for them.
 */

/** Extracted text beyond this is rejected: a small file that expands this far is suspicious. */
export const MAX_EXTRACTED_CHARS = 2_000_000;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04": a .docx is a zip archive

function startsWith(bytes: Uint8Array, magic: number[]) {
  return magic.every((byte, i) => bytes[i] === byte);
}

function unreadable(kind: string, cause?: unknown): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    `The ${kind} could not be read. It may be damaged or password-protected.`,
    { cause },
  );
}

function checkLength(text: string) {
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new AppError("VALIDATION_ERROR", "The file contains too much text to index");
  }
  return text;
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (!startsWith(bytes, PDF_MAGIC)) {
    throw new AppError("VALIDATION_ERROR", "The file is not a PDF");
  }
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pages: string[];
  try {
    // pdf.js may detach the buffer it is given, so hand it a copy.
    const pdf = await getDocumentProxy(bytes.slice());
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch (error) {
    throw unreadable("PDF", error);
  }
  return checkLength(
    pages
      .map((page) => page.trim())
      .filter(Boolean)
      .join("\n\n"),
  );
}

/** Mammoth's HTML to the markdown subset the chunker understands: headings, paragraphs, lists. */
export function htmlToMarkdown(html: string) {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => {
      return `\n\n${"#".repeat(Number(level))} ${text}\n\n`;
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|ul|ol|table)>/gi, "\n\n")
    .replace(/<\/tr>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  if (!startsWith(bytes, ZIP_MAGIC)) {
    throw new AppError("VALIDATION_ERROR", "The file is not a Word (.docx) document");
  }
  const { default: mammoth } = await import("mammoth");
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // Never follow links to files outside the document, and drop images (not indexed).
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      },
    ));
  } catch (error) {
    throw unreadable("Word document", error);
  }
  return checkLength(htmlToMarkdown(html));
}
