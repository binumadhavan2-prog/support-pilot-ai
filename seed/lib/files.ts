import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_FILES, type Meta, type SeedData } from "./schemas";

export const DATA_DIR = path.join(process.cwd(), "seed", "data");
export const PARTIAL_DIR = path.join(DATA_DIR, ".partial");

export const DEMO_NOTICE =
  'DEMO DATA. Fictional company "Acme Cloud", generated for testing and demos. No real customers, people or payment data.';

type Key = keyof typeof DATA_FILES;

export function dataPath(key: Key, dir = DATA_DIR) {
  return path.join(dir, DATA_FILES[key].file);
}

export function hasDataFile(key: Key, dir = DATA_DIR) {
  return existsSync(dataPath(key, dir));
}

/** Validates before writing, so an invalid file never lands on disk. */
export function writeDataFile<K extends Key>(
  key: K,
  items: SeedData[K]["items"],
  meta: Omit<Meta, "notice" | "generatedAt">,
  dir = DATA_DIR,
) {
  const file = DATA_FILES[key].schema.parse({
    meta: { notice: DEMO_NOTICE, generatedAt: new Date().toISOString(), ...meta },
    items,
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(dataPath(key, dir), `${JSON.stringify(file, null, 2)}\n`);
}

export function readDataFile<K extends Key>(key: K, dir = DATA_DIR): SeedData[K] {
  const file = dataPath(key, dir);
  if (!existsSync(file)) {
    throw new Error(`Missing ${path.relative(process.cwd(), file)}. Run "npm run seed:generate".`);
  }
  const parsed = DATA_FILES[key].schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(`${DATA_FILES[key].file} is invalid: ${parsed.error.message}`);
  return parsed.data as SeedData[K];
}

export function readAllDataFiles(dir = DATA_DIR): SeedData {
  return Object.fromEntries(
    (Object.keys(DATA_FILES) as Key[]).map((key) => [key, readDataFile(key, dir)]),
  ) as SeedData;
}

/** Resumable steps: cache each finished batch so a failed run does not pay for it twice. */
export function readPartial<T>(name: string): T | null {
  const file = path.join(PARTIAL_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

export function writePartial(name: string, value: unknown) {
  mkdirSync(PARTIAL_DIR, { recursive: true });
  writeFileSync(path.join(PARTIAL_DIR, `${name}.json`), JSON.stringify(value, null, 2));
}
