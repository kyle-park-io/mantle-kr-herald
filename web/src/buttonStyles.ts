// Shared Tailwind class strings for the board's buttons. Kept in one place because `OutletBoard.tsx`
// and `OutletCard.tsx` both render the same actions — a module-private duplicate string in each file
// means a palette change has to be made twice, and nothing catches the second file going stale.
//
// One geometry for all of them, matching 1차's detail pane: same radius, padding and text size, so a
// row of buttons lines up whatever mix it holds. The pair that swaps in place — `승인하기` and the
// `승인됨 ✓`/`승인 취소` control — additionally shares a minimum width, or the card visibly resizes at
// the moment of approval, which reads as something having gone wrong.
const BASE = "rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors";
/** Width of the approve/approved pair. Both must carry it; either alone still jumps. */
const APPROVE_WIDTH = "min-w-[5.5rem] justify-center";

export const btn = `${BASE} inline-flex items-center border border-line-strong bg-surface text-ink hover:bg-bg disabled:cursor-default disabled:opacity-40`;

export const btnPrimary = `${BASE} inline-flex items-center ${APPROVE_WIDTH} bg-mint text-white hover:bg-mint-hover disabled:opacity-40`;

export const btnDanger = `${BASE} inline-flex items-center border border-red-200 bg-surface text-red-600 hover:bg-red-50 disabled:cursor-default disabled:opacity-40`;

/**
 * `승인됨 ✓` that becomes `승인 취소` on hover. Both labels sit in one grid cell so the button sizes
 * to the wider of the two and never jumps mid-hover — the same control 1차 uses, shared here so the
 * two modes cannot drift apart.
 */
export const btnApproved = `${BASE} group grid ${APPROVE_WIDTH} place-items-center bg-mint-soft text-mint hover:bg-red-50 hover:text-red-600 disabled:opacity-40`;
/** The two labels inside `btnApproved`, stacked in the same cell. */
export const btnApprovedRest = "col-start-1 row-start-1 whitespace-nowrap transition-opacity group-hover:opacity-0";
export const btnApprovedHover = "col-start-1 row-start-1 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100";
