import { mkdir, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Move a file into `<archiveRoot>/<YYYY-MM-DD>/<label>-<HHmmss>-<short>.<ext>`.
 * Returns the destination, or null when the source does not exist (nothing to preserve).
 */
export async function archiveFile(
  srcPath: string,
  archiveRoot: string,
  label: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    await stat(srcPath);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }

  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(":", "");
  const dir = join(archiveRoot, day);
  await mkdir(dir, { recursive: true });

  const dest = join(dir, `${label}-${time}-${randomUUID().slice(0, 8)}${extname(srcPath)}`);
  await rename(srcPath, dest);
  return dest;
}
