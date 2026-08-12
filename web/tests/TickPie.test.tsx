// @vitest-environment jsdom
//
// The 10px pie itself. jsdom evaluates no CSS and lays nothing out, so what is testable here is what
// the element *is*: the geometry that decides where the wedge starts and how far round it goes, the
// name it offers assistive technology, and — the one that is load-bearing for a neighbouring test —
// the fact that it contributes no text to the stage it sits in.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TickPie } from "../src/components/TickPie";

/**
 * `"6.6759 26.7035"` → 0.25. The dash is the wedge; the gap is the rest of the circle.
 *
 * Compared to four decimal places below, matching what the component rounds to — the dash is in
 * viewBox units, so the difference is a ten-thousandth of a 20-unit box.
 */
const sweptFraction = (el: Element): number => {
  const [dash, whole] = (el.getAttribute("stroke-dasharray") ?? "").split(/\s+/).map(Number);
  return dash / whole;
};

describe("TickPie", () => {
  afterEach(cleanup);

  it("fills up as the next fire approaches, rather than draining", () => {
    // The direction is the whole idea — "완성되면 돈다". An empty pie means the tick just ran; a full
    // one means it is about to. Reversing this is a one-character edit that still animates
    // convincingly and tells the reviewer the opposite of the truth.
    render(<TickPie fraction={0} label="just fired" />);
    expect(sweptFraction(screen.getByTestId("tick-pie-wedge"))).toBe(0);

    cleanup();
    render(<TickPie fraction={0.25} label="a quarter of the way" />);
    expect(sweptFraction(screen.getByTestId("tick-pie-wedge"))).toBeCloseTo(0.25, 4);

    cleanup();
    render(<TickPie fraction={1} label="about to fire" />);
    expect(sweptFraction(screen.getByTestId("tick-pie-wedge"))).toBeCloseTo(1, 4);
  });

  it("starts the wedge at 12 o'clock and sweeps clockwise", () => {
    // An SVG circle begins at 3 o'clock and runs clockwise, so the quarter-turn back is what makes
    // this read as a clock face instead of starting at the right-hand edge.
    render(<TickPie fraction={0.25} label="a quarter of the way" />);
    expect(screen.getByTestId("tick-pie-wedge").getAttribute("transform")).toMatch(/^rotate\(-90[\s,]/);
  });

  it("draws a full track behind the wedge, so an almost-empty pie is still a circle", () => {
    // Without it, "just fired" would be a blank space in the funnel strip rather than an empty dial —
    // indistinguishable from a pie that failed to render.
    render(<TickPie fraction={0} label="just fired" />);
    expect(screen.getByTestId("tick-pie-track")).toBeTruthy();
  });

  it("takes its colours from the theme rather than hardcoding them", () => {
    // `styles.css` owns this palette (`--color-line`, `--color-mint`). A hex here would be the one
    // mint in the app that a palette change misses.
    render(<TickPie fraction={0.5} label="halfway" />);
    const svg = screen.getByRole("img");
    expect(screen.getByTestId("tick-pie-track").getAttribute("class")).toContain("stroke-line");
    expect(screen.getByTestId("tick-pie-wedge").getAttribute("class")).toContain("stroke-mint");
    expect(svg.outerHTML, "a literal colour in the markup").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("names itself for assistive technology without putting that name in the page's text", () => {
    // Both halves matter, and they pull against each other. An SVG `<title>` child is the obvious way
    // to caption a graphic — and it lands in `textContent`, which would put a whole sentence inside
    // the 번역 stage of the funnel. `App.tsx` documents that a stage's text must be exactly its own so
    // a test can read one stage at a time (`App.test.tsx`'s `stage()` helper is that test), so the
    // caption goes in `aria-label`, which names the element for a screen reader and stays out of the
    // text. The pointer gets the same sentence from a `title` on the wrapping span, in `App.tsx`.
    render(<TickPie fraction={0.5} label="번역 틱 · 다음 실행 14:17 KST · 14분 후" />);
    const svg = screen.getByRole("img", { name: "번역 틱 · 다음 실행 14:17 KST · 14분 후" });
    expect(svg.querySelector("title")).toBeNull();
    expect(svg.textContent).toBe("");
  });
});
