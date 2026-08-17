// Shared Tailwind class strings for the board's buttons. Kept in one place because `OutletBoard.tsx`
// and `OutletCard.tsx` both render the same actions — a module-private duplicate string in each file
// means a palette change has to be made twice, and nothing catches the second file going stale.
//
// One geometry for all of them, matching 1차's detail pane: same radius, padding and text size, so a
// row of buttons lines up whatever mix it holds. Only the pair that swaps in place — `승인하기` and
// the `승인됨 ✓`/`승인 취소` control — also shares a minimum width, or the card visibly resizes at the
// moment of approval, which reads as something having gone wrong.
const BASE = "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors";
/**
 * Width of the approve/approved pair ONLY. Both must carry it — either alone still jumps — and
 * nothing else should: on a two-syllable label like `발송` it just stretches the button.
 */
const APPROVE_WIDTH = "min-w-[5.5rem] justify-center";

export const btn = `${BASE} inline-flex items-center border border-line-strong bg-surface text-ink hover:bg-bg disabled:cursor-default disabled:opacity-40`;

export const btnPrimary = `${BASE} inline-flex items-center bg-mint text-white hover:bg-mint-hover disabled:opacity-40`;

/** `승인하기` — the same button, sized to match `승인됨 ✓` so approving does not resize the card. */
export const btnApprove = `${btnPrimary} ${APPROVE_WIDTH}`;

export const btnDanger = `${BASE} inline-flex items-center border border-red-200 bg-surface text-red-600 hover:bg-red-50 disabled:cursor-default disabled:opacity-40`;

/**
 * `승인됨 ✓` that becomes `승인 취소` on hover. Both labels sit in one grid cell so the button sizes
 * to the wider of the two and never jumps mid-hover — the same control 1차 uses, shared here so the
 * two modes cannot drift apart.
 *
 * 이 세 문자열을 직접 쓰지 말고 `ApprovedButton`을 쓸 것 — 터치에서 호버 스왑이 성립하지 않는
 * 문제(손가락 아래에서 라벨이 바뀐다)를 그 컴포넌트가 확인 다이얼로그로 막는다.
 */
export const btnApproved = `${BASE} group grid ${APPROVE_WIDTH} place-items-center bg-mint-soft text-mint hover:bg-red-50 hover:text-red-600 disabled:opacity-40`;
/** The two labels inside `btnApproved`, stacked in the same cell. */
export const btnApprovedRest = "col-start-1 row-start-1 whitespace-nowrap transition-opacity group-hover:opacity-0";
export const btnApprovedHover = "col-start-1 row-start-1 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100";
