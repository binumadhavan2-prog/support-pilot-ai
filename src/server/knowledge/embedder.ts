import "server-only";
import { getEnv } from "@/env";
import type { EmbedPassages } from "./documents";
import { embed } from "./embeddings";
import type { EmbedQuery } from "./search";

/**
 * The local embedding model, or null when SEMANTIC_SEARCH=off (low-memory machines): documents
 * are then stored without embeddings and search is keyword-only.
 */
export function getEmbedder(): { embedPassages: EmbedPassages; embedQuery: EmbedQuery } | null {
  if (getEnv().SEMANTIC_SEARCH === "off") return null;
  return {
    embedPassages: (texts) => embed(texts, "passage", { batchSize: 8 }),
    embedQuery: async (text) => (await embed([text], "query"))[0],
  };
}
