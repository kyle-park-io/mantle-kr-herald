import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `styles.css`가 `--breakpoint-*: initial`로 기본 스케일을 버렸으므로, `sm:`/`md:`/`lg:`/`xl:`는
 * 이제 존재하지 않는 변형이다. Tailwind는 모르는 변형을 오류로 만들지 않고 그냥 아무 CSS도 만들지
 * 않기 때문에, 되살아난 `md:flex` 한 줄은 화면에서만 틀리고 빌드는 성공한다. 이 테스트가 그
 * 조용한 실패를 잡는 유일한 자리다.
 */
const SRC = join(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("브레이크포인트 어휘", () => {
  it("기본 스케일 변형(sm:/md:/lg:/xl:/2xl:)을 쓰지 않는다", () => {
    const offenders: string[] = [];
    for (const path of walk(SRC).filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"))) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // className 안의 변형만 본다. `max-w-sm`·`text-sm`은 접두 변형이 아니므로 경계로 배제.
          if (/(?:^|[\s"'`])(?:sm|md|lg|xl|2xl):/.test(line)) {
            offenders.push(`${path.replace(SRC, "web/src")}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("tablet 브레이크포인트가 rem으로 정의돼 있다", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(/--breakpoint-\*:\s*initial/);
    expect(css).toMatch(/--breakpoint-tablet:\s*48rem/);
  });
});
