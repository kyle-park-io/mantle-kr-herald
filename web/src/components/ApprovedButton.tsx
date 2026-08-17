import { useState } from "react";
import { btnApproved, btnApprovedHover, btnApprovedRest } from "../buttonStyles";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";

/** What withdrawing THIS approval actually undoes — wrong here is wrong at the worst moment: the last thing a reviewer reads before the click. */
const ITEM_LEVEL_LINES = ["이 항목이 다시 검수 대기로 돌아갑니다.", "저장된 글은 그대로 남습니다."];

/**
 * `승인됨 ✓`. 마우스에서는 호버로 `승인 취소`가 되고, 터치에서는 확인 다이얼로그를 거친다.
 *
 * 호버 스왑이 터치에서 성립하지 않는 것은 단순히 "호버가 없어서"가 아니다. 일부 터치 브라우저는
 * 탭에 `:hover`를 적용하므로, 손가락 아래에서 라벨이 `승인됨 ✓`에서 `승인 취소`로 바뀐다 —
 * 취소를 의도하지 않은 사람이 취소를 누르는 경로다. 다이얼로그는 그 경로를 끊으면서 오탭 방지를
 * 겸한다.
 *
 * 다이얼로그가 마우스에서도 뜨는 이유: 경로가 둘이면 둘 다 테스트해야 하고, 승인 취소는 데스크톱에서도
 * 되돌리기가 필요한 동작이다. 호버 스왑은 "무엇을 누르는 버튼인지" 알려주는 라벨로 남고, 확인은
 * 양쪽 공통이다.
 */
export function ApprovedButton({
  onUnapprove,
  disabled,
  lines = ITEM_LEVEL_LINES,
  onConfirm,
}: {
  onUnapprove: () => void;
  disabled?: boolean;
  /**
   * What withdrawing this particular approval undoes, as the dialog's body lines. Defaults to the
   * item-level wording (`TranslationDetail`'s and the group-level `OutletCard` control both
   * withdraw the whole item's/group's approval, so they take the default). The row-level control in
   * `OutletCard`'s `Row` withdraws only that one forked room's approval — the item and every other
   * room are untouched — so it passes its own room-scoped lines rather than the default, which would
   * otherwise tell a reviewer the item goes back to 검수 대기 when it does not.
   */
  lines?: string[];
  /**
   * Delegates the confirmation to a dialog the caller already owns, instead of mounting one here.
   * `OutletCard` threads its own `onConfirm` up to the single `ConfirmDialog` `OutletBoard` renders
   * — every other irreversible action in that file (재발송, 발송) already raises through it — so both
   * of its call sites pass this rather than open a second, independent dialog instance in the same
   * file. `TranslationDetail` has no such owner to delegate to, so it leaves this unset and keeps
   * the self-contained dialog below.
   */
  onConfirm?: (request: ConfirmRequest) => void;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const request: ConfirmRequest = {
    title: "승인을 취소할까요?",
    lines,
    confirmLabel: "승인 취소",
    tone: "danger",
    onConfirm: () => onUnapprove(),
  };
  return (
    <>
      <button
        type="button"
        className={btnApproved}
        disabled={disabled}
        onClick={() => (onConfirm ? onConfirm(request) : setConfirm(request))}
      >
        <span className={btnApprovedRest}>승인됨 ✓</span>
        {/* 호버로 드러나는 시각적 라벨일 뿐, 이 버튼의 이름이 아니다. `aria-hidden`이 없으면 이
            버튼의 접근 이름이 "승인됨 ✓ 승인 취소"가 되고, 다이얼로그가 열린 뒤에는
            `getByRole("button", { name: "승인 취소" })`가 트리거와 확인 버튼 둘을 만나 실패한다.
            스크린리더 입장에서도 한 버튼이 두 동작을 말하는 것은 틀렸다. */}
        <span className={btnApprovedHover} aria-hidden="true">
          승인 취소
        </span>
      </button>
      {/* Only mounted for the self-contained path — a caller that passed `onConfirm` already has a
          dialog open elsewhere, and this one would just sit idle (registering no keydown listener,
          per `ConfirmDialog`'s own effect, since `request` here would stay null forever). */}
      {!onConfirm && <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}
