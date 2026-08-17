import { useEffect, useRef, useState } from "react";
import { InfoPopover } from "./InfoPopover";
import { btn } from "../buttonStyles";

export interface ConfirmRequest {
  title: string;
  /** One line each. The last irreversible fact belongs last, where the eye lands before the button. */
  lines: string[];
  /**
   * The copy about to go out, one entry per outgoing piece — a thread is two tweets, and confirming
   * it as one block would hide both the split and where it lands. Verbatim: this is the delivered
   * form, not the editor's, so the `---` rule the editor draws is correctly absent from it.
   */
  pieces?: string[];
  confirmLabel: string;
  /** `danger` for anything that reaches a live room or replaces a record of one. */
  tone?: "danger" | "primary";
  /**
   * An opt-in checkbox, unchecked by default and reset every time a new request replaces this one.
   * The dialog knows nothing about what the toggle means — that's on the caller reading `toggled`
   * back out of `onConfirm`.
   */
  toggle?: { label: string; hint?: string };
  onConfirm: (opts: { toggled: boolean }) => void;
}

/**
 * The board's confirm, replacing `window.confirm`.
 *
 * Not cosmetic: the native dialog renders as an unstyled OS strip that reads the same whether it is
 * asking about a draft or about a post that cannot be recalled, and it collapses the message to one
 * run of text — so the preview of what is about to be posted arrived as a wall. Here the title, the
 * consequences and the copy itself are separate blocks, and the button carries the verb.
 *
 * Esc cancels and the confirm button takes focus on open, so the keyboard path matches the native
 * one it replaces.
 */
export function ConfirmDialog({ request, onCancel }: { request: ConfirmRequest | null; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [toggled, setToggled] = useState(false);

  useEffect(() => {
    if (!request) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, onCancel]);

  useEffect(() => {
    // Every new request starts the toggle unchecked, whether it declares one or not — a tick left
    // over from the previous dialog would otherwise survive into a request that never asked for it.
    // Deliberately keyed on `request` alone, not `onCancel`: the one real caller
    // (`OutletBoard.tsx`) passes an inline `() => setConfirm(null)`, a fresh function identity on
    // every one of its own re-renders, so folding this into the effect above would flip a checked
    // box back to unchecked while the dialog sits open for the very request that ticked it.
    if (!request) return;
    setToggled(false);
  }, [request]);

  if (!request) return null;
  const danger = request.tone !== "primary";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
      // A click on the backdrop cancels; one inside the panel must not, or dragging to select the
      // preview text and releasing outside would dismiss the dialog mid-read.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span
            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[14px] ${
              danger ? "bg-red-50 text-red-600" : "bg-mint-soft text-mint"
            }`}
          >
            {danger ? "!" : "✓"}
          </span>
          <h2 className="text-[15px] font-semibold leading-6 text-ink">{request.title}</h2>
        </div>

        <div className="space-y-2 px-5 py-4">
          {request.lines.map((line) => (
            <p key={line} className="text-[13px] leading-relaxed text-muted">
              {line}
            </p>
          ))}
          {request.toggle && (
            // Given the same bordered surface the copy preview below uses, rather than sitting flush
            // in the paragraph stack: it is the one thing in this dialog the operator can still
            // decide, and read as prose it looks like another consequence line.
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2.5 text-[13px] text-ink">
              <input
                type="checkbox"
                className="mt-0.5 cursor-pointer"
                checked={toggled}
                onChange={(e) => setToggled(e.target.checked)}
              />
              <span>
                {request.toggle.label}
                {request.toggle.hint && <span className="block text-[12px] text-muted">{request.toggle.hint}</span>}
              </span>
            </label>
          )}
          {request.pieces && request.pieces.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                보낼 글{request.pieces.length > 1 && ` — ${request.pieces.length}개로 나뉘어 나갑니다`}
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {request.pieces.map((piece, i) => (
                  <div key={i} className="rounded-lg border border-line bg-bg p-3">
                    {request.pieces!.length > 1 && (
                      <div className="mb-1.5 font-mono text-[11px] font-semibold text-faint">
                        {i + 1} / {request.pieces!.length}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink/90">{piece}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-bg px-5 py-3">
          <button className={btn} onClick={onCancel}>
            취소
          </button>
          <button
            ref={confirmRef}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors pointer-coarse:min-h-11 ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-mint hover:bg-mint-hover"
            }`}
            onClick={() => {
              onCancel();
              request.onConfirm({ toggled });
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The hover card 1차 uses for an explanation that will not fit on the control itself.
 *
 * Not a native `title`: that renders as an OS tooltip after a delay, in a size nobody reads, and a
 * **disabled** button does not reliably fire hover at all — which is why the wrapper carries it
 * rather than the control.
 *
 * That last sentence is the whole reason this exists, and it is worth stating what it costs to
 * ignore: a `title` whose condition ALSO appears in the control's `disabled` expression never
 * renders. The message is in the markup, reads correctly in review, and no operator has ever seen
 * it. Nine of them had accumulated that way across this board and 1차 — every one a "why can't I
 * press this" message, which is exactly the moment the explanation was needed. Reach for `Tip`
 * whenever the reason and the disabling share a condition; a plain `title` is fine only on a
 * control that is still enabled when it carries one.
 *
 * `text: undefined` renders `children` alone rather than an empty card, so a call site can pass a
 * conditional straight through (`text={dirty ? SAVE_FIRST : undefined}`) without wrapping the
 * wrapper in a ternary. `className` lands on the wrapper because it becomes the laid-out element in
 * its parent — a control positioned by its own `ml-auto`/`flex-1` hands that class over here.
 *
 * 카드 자체는 이제 `InfoPopover`가 그린다 — 호버 전용이던 것이 탭과 키보드로도 열린다. 조상의
 * `overflow`에 잘리지 않는 것은 브라우저가 native `popover`와 CSS anchor positioning을 둘 다
 * 지원할 때만이다(`InfoPopover.tsx`의 `canPromote` 참조) — 그렇지 않은 브라우저에서는 여느 때처럼
 * 잘릴 수 있는, 평범하게 absolute-positioned된 엘리먼트로 남는다. 이 함수는 "텍스트 한 덩이"라는
 * 좁은 경우를 위한 얇은 껍질로 남는다.
 */
export function Tip({
  text,
  className,
  align = "left",
  children,
}: {
  text: string | undefined;
  className?: string;
  /**
   * Which edge the card hangs from. `left` (the default) opens down and to the right, which is where
   * the eye already is after reading the control — and matches the board's other three hover cards
   * (`CollectedBreakdownCard`, `MarkerText`, the env panel in `App.tsx`), all `left-0 top-full`.
   *
   * `right` is for a control pinned to the right edge of its container, where a `w-64` card opening
   * rightward would run off the card. There is exactly one today: `DestinationPreview`'s `ml-auto`
   * [복사].
   */
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  if (text === undefined) return <>{children}</>;
  return (
    <InfoPopover
      align={align}
      className={className}
      // `Tip` is one text blob, never interactive content, so `role="tooltip"` is correct here —
      // unlike `InfoPopover`'s general default of no role, which exists because some panels (the
      // storage-mode panel Task 3 adds) hold a button and links that `role="tooltip"` would hide
      // from screen readers.
      role="tooltip"
      panelClassName="w-64 px-3 py-2 text-[12px] font-normal leading-relaxed text-muted"
      panel={text}
    >
      {children}
    </InfoPopover>
  );
}
