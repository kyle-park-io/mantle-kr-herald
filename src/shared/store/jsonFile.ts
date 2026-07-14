import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Read + parse JSON. Missing file (ENOENT) → fallback; corrupt/other errors throw. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return fallback;
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read JSON file at ${path}: ${cause}`, { cause: err });
  }
}

/** Atomic write: temp file in the same dir + rename over the target. */
export async function writeJsonFileAtomic(dir: string, path: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
