// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchBox } from "../src/components/SearchBox";

afterEach(cleanup);

describe("SearchBox", () => {
  it("reports what was typed", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("검색"), { target: { value: "ㅁㅌ" } });
    expect(onChange).toHaveBeenCalledWith("ㅁㅌ");
  });

  it("offers the clear button only when there is something to clear", () => {
    const { rerender } = render(<SearchBox value="" onChange={() => {}} />);
    expect(screen.queryByLabelText("검색어 지우기")).toBeNull();
    rerender(<SearchBox value="맨틀" onChange={() => {}} />);
    expect(screen.getByLabelText("검색어 지우기")).toBeTruthy();
  });

  it("clears on the button and on Escape", () => {
    const onChange = vi.fn();
    render(<SearchBox value="맨틀" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("검색어 지우기"));
    expect(onChange).toHaveBeenLastCalledWith("");

    fireEvent.keyDown(screen.getByLabelText("검색"), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
