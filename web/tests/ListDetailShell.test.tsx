// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ListDetailShell } from "../src/components/ListDetailShell";

afterEach(cleanup);

/**
 * 폭에 따른 배치 자체는 CSS의 일이고 jsdom은 그것을 계산하지 않는다. 여기서 검증하는 것은 드로우의
 * 상태 기계 — 열리는가, 고르면 닫히는가, Esc로 닫히는가 — 뿐이다. 배치는 Task 11의 Playwright가 본다.
 */
describe("ListDetailShell", () => {
  const Harness = () => {
    const [picked, setPicked] = useState<string | null>(null);
    return (
      <ListDetailShell
        current={picked ?? undefined}
        list={
          <ul>
            <li><button onClick={() => setPicked("250817 첫 항목")}>250817 첫 항목</button></li>
            <li><button onClick={() => setPicked("250816 둘째 항목")}>250816 둘째 항목</button></li>
          </ul>
        }
        detail={<p>{picked ? `${picked} 상세` : "고르세요"}</p>}
      />
    );
  };

  it("☰로 드로우를 열고 다시 눌러 닫는다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "목록 닫기" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "목록 닫기" }));
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("항목을 고르면 드로우가 닫힌다 — 목록이 상세를 덮은 채로 남으면 고른 것을 볼 수 없다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.click(screen.getByText("250817 첫 항목"));
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("250817 첫 항목 상세")).toBeTruthy();
  });

  it("Esc로 닫힌다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("지금 보고 있는 것을 폰 바에 적는다 — 드로우가 닫히면 목록의 하이라이트가 안 보인다", () => {
    render(<Harness />);
    expect(screen.getByTestId("current-item").textContent).toBe("목록에서 고르세요");
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.click(screen.getByText("250816 둘째 항목"));
    expect(screen.getByTestId("current-item").textContent).toBe("250816 둘째 항목");
  });

  it("목록과 상세는 폭과 무관하게 항상 트리에 있다 — 리마운트되면 스크롤과 검색어를 잃는다", () => {
    render(<Harness />);
    expect(screen.getByText("250817 첫 항목")).toBeTruthy();
    expect(screen.getByText("고르세요")).toBeTruthy();
  });
});
