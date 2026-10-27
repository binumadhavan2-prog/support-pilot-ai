import { describe, expect, it } from "vitest";
import { stripQuotedReply, ticketNumberFromSubject } from "./threading";

describe("ticketNumberFromSubject", () => {
  it("reads the [#number] our reply emails put in the subject", () => {
    expect(ticketNumberFromSubject("Re: Export broken [#1042]")).toBe(1042);
    expect(ticketNumberFromSubject("RE: RE: AW: [#7] help")).toBe(7);
    expect(ticketNumberFromSubject("Order #1042 is late")).toBeNull();
    expect(ticketNumberFromSubject("[#abc]")).toBeNull();
  });
});

describe("stripQuotedReply", () => {
  it("keeps only the new text above Gmail, Outlook and '>' quotes", () => {
    expect(stripQuotedReply("Thanks!\n\nOn Tue, 27 Oct 2026, Acme <a@b.test> wrote:\n> old")).toBe(
      "Thanks!",
    );
    expect(stripQuotedReply("Done.\r\n-----Original Message-----\r\nFrom: Acme")).toBe("Done.");
    expect(stripQuotedReply("Yes\n> quoted line\nand more")).toBe("Yes\nand more");
  });

  it("keeps the whole message when stripping would leave nothing", () => {
    expect(stripQuotedReply("> only quoted text")).toBe("> only quoted text");
  });
});
