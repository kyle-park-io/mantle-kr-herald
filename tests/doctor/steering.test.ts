import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TYPES } from "../../src/domain/conversion/models";
import { steeringFiles, missingSteeringFiles, skeletonSteeringFiles } from "../../src/doctor/steering";

let root: string;
let translationDir: string;
let conversionDir: string;

/** A config:init-style tree: every real file present, every one identical to its skeleton. */
async function writeSkeletons(): Promise<void> {
  const glossary = "[]\n";
  await writeFile(join(translationDir, "glossary.example.json"), glossary);
  await writeFile(join(translationDir, "glossary.json"), glossary);
  await writeFile(join(translationDir, "locale.json"), '{"dateFormat":"M월 D일"}\n');
  const guide = "# 스켈레톤\n\n여기에 규칙을 채워 넣으세요.\n";
  await writeFile(join(translationDir, "style-guide.example.md"), guide);
  await writeFile(join(translationDir, "style-guide.md"), guide);
  for (const type of ALL_TYPES) {
    await writeFile(join(conversionDir, `${type}.example.md`), guide);
    await writeFile(join(conversionDir, `${type}.md`), guide);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "steering-"));
  translationDir = join(root, "translation");
  conversionDir = join(root, "conversion");
  await mkdir(translationDir);
  await mkdir(conversionDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("steeringFiles", () => {
  it("requires a guide for every conversion type", () => {
    const files = steeringFiles(translationDir, conversionDir);
    for (const type of ALL_TYPES) {
      expect(files, `guide for ${type}`).toContain(join(conversionDir, `${type}.md`));
    }
  });
});

describe("missingSteeringFiles", () => {
  it("reports an empty tree as entirely missing, and a full one as complete", async () => {
    const files = steeringFiles(translationDir, conversionDir);
    expect(await missingSteeringFiles(files)).toHaveLength(files.length);

    await writeSkeletons();
    expect(await missingSteeringFiles(files)).toEqual([]);
  });
});

describe("skeletonSteeringFiles", () => {
  it("flags a config:init tree — files exist, so presence alone would report ok", async () => {
    await writeSkeletons();
    const found = await skeletonSteeringFiles(translationDir, conversionDir);

    expect(found).toContain("translation/glossary.json");
    expect(found).toContain("translation/style-guide.md");
    for (const type of ALL_TYPES) expect(found, `guide for ${type}`).toContain(`conversion/${type}.md`);
  });

  it("stays silent once the files carry real content", async () => {
    await writeSkeletons();
    await writeFile(
      join(translationDir, "glossary.json"),
      JSON.stringify([{ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-21" }]),
    );
    await writeFile(join(translationDir, "style-guide.md"), "# 실제 가이드\n\n합니다체를 씁니다.\n");
    for (const type of ALL_TYPES) {
      await writeFile(join(conversionDir, `${type}.md`), `# ${type} 실제 지침\n\n핵심을 앞에 둡니다.\n`);
    }
    expect(await skeletonSteeringFiles(translationDir, conversionDir)).toEqual([]);
  });

  it("ignores whitespace-only differences from the skeleton", async () => {
    await writeSkeletons();
    await writeFile(join(conversionDir, "x.md"), "# 스켈레톤\n\n여기에 규칙을 채워 넣으세요.\n\n\n");
    expect(await skeletonSteeringFiles(translationDir, conversionDir)).toContain("conversion/x.md");
  });

  it("leaves a missing file to the presence check rather than double-reporting", async () => {
    // Nothing written at all: skeleton detection must stay quiet so `doctor` reports the cause once.
    expect(await skeletonSteeringFiles(translationDir, conversionDir)).toEqual([]);
  });
});
