import "server-only";
import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { getEnv } from "@/env";
import { logger } from "@/lib/logger";

/**
 * Local, free embeddings: `multilingual-e5-small` (384 dims, ~120 MB quantized) runs on the CPU
 * through ONNX Runtime. No API key, and nothing leaves the server. Multilingual, so Hinglish and
 * Tanglish tickets still land near the English articles that answer them.
 *
 * The model downloads from Hugging Face on first use into `.cache/transformers` (git-ignored).
 * In production, warm the cache at build time so a cold start does not need the network.
 */
export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

// e5 models are trained with these prefixes; leaving them out noticeably hurts retrieval.
const PREFIX = { query: "query: ", passage: "passage: " } as const;
export type EmbeddingKind = keyof typeof PREFIX;

env.fetch = fetchWithRetry;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor() {
  // Set on first use, not at import, so importing this module never needs a valid environment.
  env.cacheDir = getEnv().MODEL_CACHE_DIR ?? path.join(process.cwd(), ".cache", "transformers");
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" }).catch(
    (error: unknown) => {
      extractor = undefined; // let the next call retry instead of caching the failure
      throw error;
    },
  );
  return extractor;
}

/**
 * Embeds `texts` as unit vectors (cosine similarity = dot product). Use `query` for search input
 * and `passage` for stored chunks. Batches internally to bound memory.
 */
export async function embed(
  texts: string[],
  kind: EmbeddingKind,
  { batchSize = 16 } = {},
): Promise<number[][]> {
  const model = await getExtractor();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => PREFIX[kind] + t);
    const output = await model(batch, { pooling: "mean", normalize: true });
    vectors.push(...(output.tolist() as number[][]));
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Expected ${EMBEDDING_DIMENSIONS}-dim embeddings, got ${vector.length}`);
    }
  }
  return vectors;
}

/**
 * Model downloads go to a CDN that can be slow to connect from some networks, and undici's
 * fetch gives up after 10 s. Retry transient network failures with backoff.
 */
async function fetchWithRetry(input: string | URL, init?: RequestInit): Promise<Response> {
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt >= attempts) throw error;
      logger.warn({ url: String(input), attempt }, "model download failed, retrying");
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}
