// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ListDetailShell } from "../src/components/ListDetailShell";

afterEach(cleanup);

/**
 * 폭에 따른 배치 자체는 CSS의 일이고 jsdom은 그것을 계산하지 않는다. 여기서 검증하는 것은 드로우의
 * 상태 기계 — 열리는가, 고르면 닫히는가, Esc/백드롭/자신의 닫기 버튼으로 닫히는가, 포커스가
 * 오가는가 — 뿐이다. 배치는 Task 11의 Playwright가 본다.
 *
 * `list`에는 `<li>` 밖에 필터 버튼을 하나 심어둔다 — 선택으로 인한 닫힘이 "li 안의 버튼/링크에서
 * 시작된 클릭"으로 구현돼 있어서, 그 규칙이 실제 목록의 필터 탭·검색창 지우기 버튼처럼 `li` 밖의
 * 컨트롤은 건드리지 않는지를 이 파일 안에서도 증명할 수 있어야 한다.
 */
describe("ListDetailShell", () => {
  const Harness = () => {
    const [picked, setPicked] = useState<string | null>(null);
    const [filter, setFilter] = useState("all");
    return (
      <ListDetailShell
        current={picked ?? undefined}
        list={
          <div>
            <button data-testid="filter-btn" onClick={() => setFilter(filter === "all" ? "narrow" : "all")}>
              필터
            </button>
            <ul>
              <li><button onClick={() => setPicked("250817 첫 항목")}>250817 첫 항목</button></li>
              <li><button onClick={() => setPicked("250816 둘째 항목")}>250816 둘째 항목</button></li>
            </ul>
          </div>
        }
        detail={<p>{picked ? `${picked} 상세` : "고르세요"}</p>}
      />
    );
  };

  it("☰로 드로우를 열고, 드로우 자신의 닫기 버튼으로 닫는다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "목록 닫기" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("백드롭을 누르면 닫힌다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("drawer-backdrop"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("항목을 고르면 드로우가 닫힌다 — 목록이 상세를 덮은 채로 남으면 고른 것을 볼 수 없다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.click(screen.getByText("250817 첫 항목"));
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("250817 첫 항목 상세")).toBeTruthy();
  });

  it("이미 고른 항목을 다시 눌러도 드로우가 닫힌다 — current는 안 바뀌지만 선택 자체가 닫는 이유다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    const item = () => screen.getByRole("button", { name: "250817 첫 항목" });
    fireEvent.click(toggle);
    fireEvent.click(item());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(item());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("li 밖의 버튼(필터 등)을 눌러도 드로우는 닫히지 않는다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("filter-btn"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("Esc로 닫힌다", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "목록 열기" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "목록 열기" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("열리면 포커스가 드로우 안(닫기 버튼)으로 이동하고, 닫히면 ☰로 되돌아온다", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "목록 열기" });
    fireEvent.click(toggle);
    const closeBtn = screen.getByRole("button", { name: "목록 닫기" });
    expect(document.activeElement).toBe(closeBtn);
    fireEvent.click(closeBtn);
    expect(document.activeElement).toBe(toggle);
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
