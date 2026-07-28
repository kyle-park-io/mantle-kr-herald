// Shared Tailwind class strings for the board's buttons. Kept in one place because
// `OutletBoard.tsx` and `OutletCard.tsx` both render a "primary" (mint) action button — a
// module-private duplicate string in each file means a palette change has to be made twice, and
// nothing catches the second file silently going stale.
export const btn =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-bg disabled:cursor-default disabled:opacity-40";
export const btnPrimary =
  "rounded-md bg-mint px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-mint-hover disabled:opacity-40";
export const btnDanger =
  "rounded-md border border-red-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-default disabled:opacity-40";
