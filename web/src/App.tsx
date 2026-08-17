import { Fragment, useEffect, useState } from "react";
import { api } from "./api";
import type { Translation, AppStatus, PublishStateRow } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { RenderingsView } from "./components/RenderingsView";
import { ListDetailShell } from "./components/ListDetailShell";
import { IntakeView } from "./components/IntakeView";
import { EnvironmentBanner } from "./components/EnvironmentBanner";
import { CollectedBreakdownCard } from "./components/CollectedBreakdownCard";
import { InfoPopover } from "./components/InfoPopover";
import { TickPie } from "./components/TickPie";
import { btn } from "./buttonStyles";
import { livenessChip, livenessHeadline, probeLabel } from "./liveness";
import { useNow } from "./useNow";
import { CONVERT_TICK, WATCH_TICK, tickPhase, tickTooltip, type TickSchedule } from "./tickSchedule";

/**
 * Every tab, once. The four things a tab needs — its id, the hash that addresses it, the label on
 * the button, and the fact that it exists at all — were four separate literals in this file, and a
 * new tab meant finding all four. `modeFromHash` folding *every* unrecognised hash into
 * `"translations"` made the miss silent: a tab whose hash arm was forgotten does not error, it
 * quietly opens 1차 검수 instead.
 *
 * The first entry is the default, and its hash is "" — the bare url is 1차 검수.
 *
 * 다섯 번째 사실은 `short` — 폰에서 쓰는 축약 라벨이다. 세 탭의 전체 라벨은 390px 헤더에서 다른
 * 컨트롤들과 함께 세 줄로 접히는데, 이 대시보드에서 헤더 세 줄은 상세 pane을 그만큼 밀어낸다.
 */
const TABS = [
  { id: "translations", hash: "", label: "1차 검수 · 번역", short: "1차" },
  { id: "renderings", hash: "#renderings", label: "2차 검수 · 채널", short: "2차" },
  { id: "intake", hash: "#intake", label: "링크 수집", short: "수집" },
] as const;

type Mode = (typeof TABS)[number]["id"];

/**
 * The mode lives in the URL hash so a reload comes back to it. A reviewer working through 2차 who
 * refreshes — or follows a `원문 ↗` link and comes back — was landing in 1차 every time, with the
 * item they were on deselected.
 *
 * The hash rather than localStorage: it survives a reload the same way, it makes the two modes
 * linkable and back-button-able, and it keeps two windows independent, which storage would not.
 */
const modeFromHash = (): Mode => TABS.find((t) => t.hash === window.location.hash)?.id ?? TABS[0].id;

/**
 * Not a funnel, despite the name it kept: the stages after 번역 branch rather than narrow, and 발행
 * hangs off 번역 rather than off 렌더 (it counts the translation markdown on Drive). The separator
 * is `·` and not `→` for exactly that reason — an arrow claims "of these N, M advanced", which is
 * false at every step here. Each stage shows its item count, plus its row count when the two differ.
 */
const FUNNEL_STEPS = [
  ["수집", "collected"],
  ["번역", "translated"],
  ["변환", "converted"],
  ["렌더", "rendered"],
  ["발행", "published"],
] as const;

/**
 * The two stages a systemd timer fills, and the tick that fills each — everything else on the strip
 * advances because a person did something.
 *
 * 번역 is where `herald-watch` (`*-*-* 0/2:17:00`) leaves its work, so it is the head of the 1차 검수
 * queue. 렌더 is where `herald-convert` (`*-*-* *:07,37:00`) leaves its own: that tick runs
 * `convert:save` and `format` in one go, so 변환 is a waypoint it passes through rather than a place
 * anything comes to rest — which is why the pie goes on 렌더 and not on both. 수집 moves when someone
 * pastes a link, and 발행 when someone clicks 발행; a countdown on either would be counting down to
 * nothing.
 *
 * The schedule itself is `tickSchedule.ts`, pinned against `deploy/*.timer` by
 * `tests/deploy/dashboardTickTiming.test.ts`.
 */
const STAGE_TICK: Partial<Record<(typeof FUNNEL_STEPS)[number][1], { name: string; schedule: TickSchedule }>> = {
  translated: { name: "번역 틱", schedule: WATCH_TICK },
  rendered: { name: "변환 틱", schedule: CONVERT_TICK },
};

const GROUP_LABEL: Record<"collect" | "publish" | "send" | "data", string> = {
  collect: "수집",
  publish: "발행",
  send: "전송",
  data: "데이터",
};

export function App({ onSignOut, authEpoch }: { onSignOut: () => void; authEpoch: number }) {
  const [mode, setMode] = useState<Mode>(modeFromHash);
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [publishRows, setPublishRows] = useState<PublishStateRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // One clock for both countdown pies below — see `useNow` on why it is read here and passed down
  // rather than called twice.
  const now = useNow();

  // Clears on success, because the `authEpoch` effect below re-runs this after a login and the
  // failure it is recovering from is usually the cold-start 401 — leaving that set would park
  // "unauthenticated" across the top of a board that just signed in successfully.
  const refresh = () =>
    api
      .list()
      .then((next) => {
        setItems(next);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));

  const refreshStatus = () => {
    api.status().then(setStatus).catch(() => setStatus(null));
    api.publishState().then(setPublishRows).catch(() => setPublishRows([]));
  };
  // `authEpoch` (`Root.tsx`'s own doc comment has the full story) — not `[]` — because `<App>` now
  // mounts once and is only ever hidden, never remounted, across a `#login` round trip. Without it,
  // a cold-start login (no session yet when this effect's first run 401s) would never retry, and the
  // board would sit on "해당하는 항목이 없습니다" forever, not because there is nothing to review.
  useEffect(() => {
    refresh();
    refreshStatus();
  }, [authEpoch]);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 모드를 바꿀까요?")) return;
    setDirty(false);
    setMode(m);
    window.location.hash = TABS.find((t) => t.id === m)?.hash ?? "";
  };

  // Back/forward, or the hash edited by hand. The confirm above is deliberately not repeated: the
  // navigation already happened, so refusing it here would leave the URL and the screen disagreeing.
  //
  // `#login` is skipped rather than fed through `modeFromHash()`: it is not one of this router's own
  // routes, it is `Root.tsx`'s pseudo-route for the sign-in overlay, which now sits on top of `<App>`
  // without unmounting it (see `Root.tsx`'s own comment on why). `modeFromHash()` maps anything that
  // is not `"#renderings"` — `#login` included — to `"translations"`, so without this guard a session
  // lapsing while `mode` is `"renderings"` would flip it to `"translations"` the moment the hash
  // became `#login`, unmounting `RenderingsView` (and whatever unsaved edit was live in it) even
  // though `<App>` itself stayed mounted. Skipping the update here means `mode` sits still, hidden,
  // for as long as the overlay is up, and the hash change back to the real route on a successful
  // login resolves it correctly on its own — nothing here needs to remember to restore it.
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === "#login") return;
      setMode(modeFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleSelect = (id: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedId(id);
  };
  const onSave = async (id: string, koreanText: string) => {
    setError(null);
    try {
      await api.edit(id, koreanText);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onApprove = async (id: string) => {
    setError(null);
    try {
      await api.approve(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onPublishOne = async (id: string, target: string) => {
    setError(null);
    try {
      const res = await api.publishOne(id, target);
      refreshStatus(); // refreshes both status and publish state (App.tsx's refreshStatus fetches both)
      if (res.failed > 0) setError(`발행 실패: ${res.failures.map((f) => f.error).join("; ")}`);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onUnapprove = async (id: string) => {
    setError(null);
    try {
      await api.unapprove(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onUnretire = async (id: string) => {
    setError(null);
    try {
      await api.unretire(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onRetire = async (id: string) => {
    setError(null);
    try {
      await api.retire(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  /**
   * [지금 확인]: two requests, deliberately, and no grading here. `/api/diagnostics/live` makes the
   * deployment re-probe every credential and record what it observed (its response body is not read
   * — the route's own doc comment explains why); `/api/status` is then re-read for the graded
   * summary Task 5's `livenessChip`/`livenessHeadline` consume, so severity is computed exactly once,
   * server-side, whether the operator is looking or not.
   */
  const recheckLiveness = () => {
    setChecking(true);
    setCheckError(null);
    api
      .liveness()
      .then(() => api.status().then(setStatus))
      .catch((e) => setCheckError(String((e as Error).message ?? e)))
      .finally(() => setChecking(false));
  };

  const isCloud = status?.storageMode === "cloud";
  const syncWarn = !!status && (status.sync.needsRepublish > 0 || status.sync.unpublished > 0);
  const chip = livenessChip(status?.liveness, new Date());

  return (
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <EnvironmentBanner status={status} />
      <header className="shrink-0 border-b border-line bg-surface">
        {/* Every child below is `shrink-0` so a control never squishes down to illegible,
            letter-wrapped Korean text under real width pressure (a narrow phone) — the defect this
            row exists to avoid, sign-out button included. The row itself *wraps* onto a second line
            when it runs out of width (`flex-wrap` + `min-h-14`, not a fixed `h-14`) rather than
            scrolling sideways: `overflow-x-auto` looked like the same fix, but setting `overflow-x`
            forces the computed `overflow-y` to `auto` too — a box cannot have `visible` on one axis
            and something else on the other — which turned this row into a clip box on *both* axes
            and silently hid the storage-mode pill's hover popover just below (`top-full`,
            absolutely positioned, taller than `h-14`) at every width, not only narrow ones.
            Wrapping needs no `overflow` here at all, so nothing below can ever be clipped by it. */}
        <div className="flex flex-wrap min-h-14 items-center gap-x-4 gap-y-2 px-5 py-2">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-mint" />
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight">
              Mantle KR <span className="text-faint font-normal hidden tablet:inline">Review</span>
            </span>
          </div>

          {status && (
            <InfoPopover
              className="shrink-0"
              panelClassName="w-72 p-3 text-[12px] leading-relaxed text-muted"
              panel={
                <>
                  <p className="mb-1 font-semibold text-ink">
                    현재 <span className={isCloud ? "text-mint" : "text-amber-ink"}>{status.storageMode}</span> 모드
                  </p>
                  <p>
                    {isCloud
                      ? "발행하면 Google · Lark Drive에 올라갑니다."
                      : "발행하면 로컬 폴더(output/publish/local/)에 저장됩니다."}
                  </p>

                  <div className="mt-2 space-y-2 border-t border-line pt-2">
                    {(["collect", "publish", "send", "data"] as const).map((g) => {
                      const rows = status.integrations.filter((i) => i.group === g);
                      if (rows.length === 0) return null;
                      return (
                        <div key={g}>
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                            {GROUP_LABEL[g]}
                          </div>
                          <ul className="space-y-0.5">
                            {rows.map((i) => (
                              <li key={i.key} className="flex items-center gap-1.5">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${i.configured ? "bg-mint" : "bg-amber-ink"}`}
                                />
                                <span className="text-ink">{i.label}</span>
                                <span className={`ml-auto ${i.configured ? "text-mint" : "text-amber-ink"}`}>
                                  {i.configured ? "설정됨" : "키 없음"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>

                  {status.liveness ? (
                    <div className="mt-2 space-y-1 border-t border-line pt-2">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">키 응답</div>
                      <p className={status.liveness.worst === "ok" ? "text-ink" : "font-medium text-amber-ink"}>
                        {livenessHeadline(status.liveness, new Date())}
                      </p>
                      {status.liveness.dead.map((d) => (
                        <div key={d.key} className="flex items-start gap-1.5">
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${d.severity === "fail" ? "bg-red-500" : "bg-amber-ink"}`}
                          />
                          <span className="text-ink">{probeLabel(d.key)}</span>
                          {/* `break-words` — a dead probe's `detail` is an English sentence of varying
                              length, and this card is a fixed `w-72`; without it a long detail would
                              force the row wider than the card instead of wrapping inside it. */}
                          <span
                            className={`ml-auto max-w-[60%] break-words text-right ${d.severity === "fail" ? "text-red-600" : "text-amber-ink"}`}
                          >
                            {d.detail}
                          </span>
                        </div>
                      ))}
                      {checkError && <p className="text-red-600">⚠ {checkError}</p>}
                    </div>
                  ) : (
                    // Task 4's own pinned state: a database that has never been probed reports no
                    // `liveness` at all. A first-ever [지금 확인] that fails must still say so — the
                    // block above is the only place `checkError` rendered before this fix, and it
                    // never runs when `status.liveness` is undefined, which is exactly the deployment
                    // this button exists to help most (nothing has ever looked, and the first click
                    // just failed too).
                    checkError && <p className="mt-2 border-t border-line pt-2 text-red-600">⚠ {checkError}</p>
                  )}
                  <div className="mt-2 flex justify-end">
                    <button type="button" className={btn} disabled={checking} onClick={recheckLiveness}>
                      {checking ? "확인 중…" : "지금 확인"}
                    </button>
                  </div>

                  <p className="mt-2 text-faint">
                    모드를 바꾸려면 서버를 끄고 <code className="font-mono">.env</code>의{" "}
                    <code className="font-mono">HERALD_STORAGE_MODE</code>를 고친 뒤 다시 실행하세요. 대시보드에서는 바꿀 수
                    없습니다.
                  </p>
                  {status.integrations.some((i) => !i.configured) && (
                    <p className="mt-1.5 text-faint">
                      <span className="text-amber-ink">키 없음</span> 항목은 <code className="font-mono">.env</code>에 해당 키를
                      채우고 서버를 다시 실행하면 활성화됩니다.
                    </p>
                  )}
                </>
              }
            >
              <span
                className={`inline-flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                  isCloud ? "bg-mint-soft text-mint" : "bg-amber-soft text-amber-ink"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isCloud ? "bg-mint" : "bg-amber-ink"}`} />
                {status.storageMode}
              </span>
              {chip && (
                <span
                  className={`ml-1.5 inline-flex shrink-0 items-center rounded-full px-2 py-1 text-xs font-medium ${
                    chip.tone === "red" ? "bg-red-50 text-red-700" : "bg-amber-soft text-amber-ink"
                  }`}
                >
                  ⚠ {chip.text}
                </span>
              )}
            </InfoPopover>
          )}

          <nav className="ml-2 inline-flex shrink-0 rounded-lg border border-line bg-bg p-0.5">
            {TABS.map(({ id, label, short }) => (
              <button
                key={id}
                onClick={() => switchMode(id)}
                // Without this, the accessible name would be content-derived — correctly, in a real
                // browser: `display: none` removes a span from the a11y tree, so only whichever span
                // the CSS currently shows is ever announced (the doubled name jsdom sees is a jsdom
                // artifact, with no CSS applied there at all). But that means a phone's screen reader
                // would hear only `short` — "1차" rather than "1차 검수 · 번역" — since `short` exists
                // purely to save on-screen space, not because the shorter phrase is what a listener
                // should hear. `aria-label` pins the announced name to the full label at every width.
                aria-label={label}
                className={`whitespace-nowrap rounded-[7px] px-3 py-1 text-[13px] font-medium transition-colors pointer-coarse:min-h-11 ${
                  mode === id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                <span className="tablet:hidden">{short}</span>
                <span className="hidden tablet:inline">{label}</span>
              </button>
            ))}
          </nav>

          {/* Wraps the (desktop-only) status funnel and the sign-out control together so the whole
              group pushes to the header's right edge — on a narrow screen the funnel hides
              (`hidden tablet:flex` below) but 로그아웃 still lands at the far right on its own.
              `flex-wrap` on both this div and the one below it: every other control in this header
              is narrow enough to fit a tablet-width line by itself, but sheet links + a five-stage
              funnel + the sync badge, combined, are not — at 834px wide with a non-empty sync badge
              this group alone measured wider than the viewport, and being `shrink-0` (like every
              other child here, so none of them squish to illegible text) it overflowed sideways
              instead of shrinking. The fix is the same one the outer header row already uses:
              wrap instead of shrink, at the granularity of this group's own three chunks — sheet
              links, the funnel, and the sync badge — each `shrink-0` below for the same reason the
              row's own children are. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {status && (
              <div className="hidden flex-wrap items-center justify-end gap-x-3 gap-y-2 tablet:flex">
                {/* Left of the funnel and set apart with a wider gap: these leave the dashboard,
                    while everything to the right of them reports on it. Each appears only when its id
                    is configured, so an empty GSHEET_QA_ID hides QA rather than linking nowhere. */}
                {(status.sheetLinks.data || status.sheetLinks.qa) && (
                  <span className="mr-3 flex shrink-0 items-center gap-3 text-[13px]">
                    {status.sheetLinks.data && (
                      <a
                        href={status.sheetLinks.data.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-mint underline-offset-2 hover:underline"
                        title="팀 데이터 시트 — history · x-performance · targets"
                      >
                        {status.sheetLinks.data.title} ↗
                      </a>
                    )}
                    {status.sheetLinks.qa && (
                      <a
                        href={status.sheetLinks.qa.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-amber-ink underline-offset-2 hover:underline"
                        title="QA 시트 — 요청·이슈를 여기에 적어주세요 (점검 현황 · 미완 항목 · 변경 이력)"
                      >
                        {status.sheetLinks.qa.title} ↗
                      </a>
                    )}
                  </span>
                )}
                <div
                  data-testid="funnel"
                  className="flex shrink-0 items-center gap-1.5 text-[13px]"
                  title={
                    "숫자는 항목 수, N건은 그 항목들이 만든 행 수입니다 — " +
                    "변환은 타입마다, 렌더는 채널마다, 발행은 업로드 대상마다 한 행씩 생깁니다. " +
                    "발행은 렌더가 아니라 번역에서 갈라져 나오는 별개 가지입니다."
                  }
                >
                  {FUNNEL_STEPS.map(([label, key], i) => {
                    const tally = status.funnel[key];
                    // 수집 is the one stage whose number needs qualifying — see
                    // `CollectedBreakdownCard`. The strip itself is untouched: `InfoPopover`'s own
                    // trigger span *is* a wrapper around the label/count spans below, but the card it
                    // renders (only while its popover is open) is a sibling of that trigger span, not
                    // of the label/count spans themselves — so `수집 134` keeps its value whether the
                    // card is open or not, and keeps its density via its own `flex gap-1.5` wrapper.
                    const collected = key === "collected";
                    // Both `undefined` on the three stages no timer feeds. The sentence is built once
                    // and used twice — as the pointer's tooltip and as the pie's accessible name —
                    // because a screen reader and a hover must not be able to say different things.
                    const tick = STAGE_TICK[key];
                    const phase = tick && tickPhase(now, tick.schedule);
                    const tickTip = tick && phase && tickTooltip(tick.name, phase);
                    return (
                      // The separator is a sibling of the stage, not a child of it, so a stage's own
                      // text is exactly its own — which is what lets a test read one stage at a time.
                      <Fragment key={key}>
                        {i > 0 && <span className="text-line-strong">·</span>}
                        <div data-testid={`funnel-${key}`} className="flex items-center gap-1.5">
                          {/* The countdown's own tooltip, on a span of its own. Same problem 수집
                              solves below and a cheaper answer: the funnel's `title` explains
                              items-vs-rows, and the nearest titled ancestor is what the pointer gets,
                              so a `title` here simply wins for the pixels the pie occupies — no
                              hover card needed, because this one is a sentence rather than a table. */}
                          {phase && tickTip && (
                            <span
                              className="flex shrink-0 cursor-help items-center"
                              title={tickTip}
                            >
                              <TickPie fraction={phase.fraction} label={tickTip} />
                            </span>
                          )}
                          {/* No `title=""` on this stage any more, unlike before this task — that
                              trick existed only to stop the funnel div's own `title` (items-vs-rows,
                              above) from surfacing as a native OS tooltip over this stage's card. On
                              the promoted path (native `showPopover` + CSS anchor positioning both
                              supported) the card is in the top layer, above everything painted in
                              normal flow including a native tooltip from an ancestor, so nothing can
                              overlap it there. That is not true on the un-promoted path: there the
                              card is an ordinary absolutely-positioned element with no such
                              protection, and the funnel's `title` can still render over it on a long
                              enough hover. Left unrestored anyway — it is a native tooltip, on a
                              browser too old for the top layer, saying something the card's own text
                              already covers, not a silent loss. */}
                          {collected ? (
                            <InfoPopover
                              panelClassName="w-80 p-3 text-[12px] font-normal leading-relaxed text-muted"
                              panel={<CollectedBreakdownCard breakdown={status.funnel.collected.breakdown} />}
                            >
                              {/* `InfoPopover`'s own trigger span is `inline-flex` with no gap of its
                                  own (it has to work for any `children`, most of which are a single
                                  element) — without this wrapper the three spans below sit flush
                                  against each other (`수집134`, not `수집 134`), because JSX drops the
                                  whitespace between adjacent JSX elements. */}
                              <span className="flex items-center gap-1.5">
                                <span className="text-muted">{label}</span>
                                <span className="font-mono text-xs font-semibold tabular-nums">{tally.items}</span>
                                {tally.rows !== tally.items && (
                                  <span className="font-mono text-[11px] tabular-nums text-faint">{tally.rows}건</span>
                                )}
                              </span>
                            </InfoPopover>
                          ) : (
                            <>
                              <span className="text-muted">{label}</span>
                              <span className="font-mono text-xs font-semibold tabular-nums">{tally.items}</span>
                              {tally.rows !== tally.items && (
                                <span className="font-mono text-[11px] tabular-nums text-faint">{tally.rows}건</span>
                              )}
                            </>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
                {/* One `shrink-0` wrap unit, not two — a lone divider bar wrapped onto its own line
                    with the sync badge below it would read as a stray mark. */}
                <span className="flex shrink-0 items-center gap-3">
                  <span className="h-4 w-px bg-line" />
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-medium ${syncWarn ? "text-amber-ink" : "text-mint"}`}
                    title="발행됨 · 재발행 필요 · 미발행"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${syncWarn ? "bg-amber-ink" : "bg-mint"}`} />
                    발행됨 {status.sync.synced}
                    {status.sync.needsRepublish > 0 ? ` · 재발행 필요 ${status.sync.needsRepublish}` : ""}
                    {status.sync.unpublished > 0 ? ` · 미발행 ${status.sync.unpublished}` : ""}
                  </span>
                </span>
              </div>
            )}
            {/* The board's own `btn` geometry — the header's one control that acts rather than
                reports, so it reads as a button among labels rather than inventing its own style. */}
            <button onClick={onSignOut} className={`${btn} shrink-0 whitespace-nowrap`}>
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</div>
      )}

      {mode === "translations" && (
        <ListDetailShell
          current={selected?.itemId}
          list={<TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />}
          detail={
            selected ? (
              <TranslationDetail
                item={selected}
                publishRows={publishRows.filter((r) => r.itemId === selected.itemId)}
                availableTargets={status?.availableTargets ?? []}
                onSave={onSave}
                onApprove={onApprove}
                onUnapprove={onUnapprove}
                onUnretire={onUnretire}
                onRetire={onRetire}
                onPublish={onPublishOne}
                onDirtyChange={setDirty}
              />
            ) : (
              <EmptyState title="검수할 항목을 선택하세요" hint="왼쪽 목록에서 번역을 골라 원문과 나란히 확인하고 승인합니다." />
            )
          }
        />
      )}

      {mode === "renderings" && (
        <RenderingsView
          onDirtyChange={setDirty}
          authEpoch={authEpoch}
          // Defaults open while `status` has not loaded yet (or failed to) rather than flashing
          // every send button locked for a moment — the route enforces the real gate regardless of
          // what this reads, so an over-optimistic default here costs nothing but a stale tooltip.
          sendsEnabled={status?.sendsEnabled ?? true}
          conversionEnabled={status?.conversionEnabled ?? true}
        />
      )}

      {mode === "intake" && (
        <IntakeView
          authEpoch={authEpoch}
          // Defaults open while `status` has not loaded, the same reason the two flags above do:
          // the route enforces the real gate regardless, so an optimistic default costs a stale tip.
          intakeEnabled={status?.intakeEnabled ?? true}
        />
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
          ☰
        </div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="mt-1 text-[13px] leading-relaxed text-faint">{hint}</p>}
      </div>
    </div>
  );
}
