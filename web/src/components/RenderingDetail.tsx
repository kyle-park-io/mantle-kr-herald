import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { DESTINATION_LABEL, renderingKey, type Destination, type Emissions, type Rendering } from "../types";
import { RenderingChip } from "./RenderingList";

export function RenderingDetail(props: {
  item: Rendering;
  onSave: (item: Rendering, text: string) => Promise<string | undefined>;
  onApprove: (item: Rendering) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { onDirtyChange } = props;
  const [text, setText] = useState(props.item.text);
  const [busy, setBusy] = useState(false);
  const [emissions, setEmissions] = useState<Emissions>({});
  const [tab, setTab] = useState<Destination | null>(null);
  const [emissionsError, setEmissionsError] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const prevRenderingKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    const key = renderingKey(props.item);
    const isDifferentRendering = prevRenderingKeyRef.current !== key;
    prevRenderingKeyRef.current = key;
    if (isDifferentRendering) {
      // Switching to a different rendering: drop the previous item's tabs/segments
      // right away so nothing stale renders under the new header while we fetch.
      // A same-rendering refetch (a save) instead leaves the current content up.
      setEmissions({});
      setTab(null);
    }
    setEmissionsError(false);
    api
      .emissions(props.item.itemId, props.item.type, props.item.channel)
      .then((e) => {
        if (!live) return;
        setEmissions(e);
        setTab((prev) => (prev && e[prev] ? prev : ((Object.keys(e)[0] as Destination) ?? null)));
      })
      .catch(() => {
        if (!live) return;
        setEmissions({});
        setTab(null);
        setEmissionsError(true);
      });
    return () => {
      live = false;
    };
  }, [props.item.itemId, props.item.type, props.item.channel, props.item.text]);

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };
  useEffect(() => setText(props.item.text), [props.item.itemId, props.item.type, props.item.channel, props.item.text]);

  const dirty = text !== props.item.text;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6 sm:p-8">
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-[12px] font-medium text-ink">
          {props.item.type} · {props.item.channel}
        </span>
        <RenderingChip status={props.item.status} />
        {props.item.refined && <span className="text-[11px] text-faint">refined</span>}
        <code className="ml-auto font-mono text-[11px] text-faint">{props.item.itemId}</code>
      </div>

      <section className="mb-6">
        <div className="eyebrow mb-2">변환 원문 · converted</div>
        <div className="rounded-xl border border-line bg-surface p-4 text-[14px] leading-relaxed whitespace-pre-wrap text-muted shadow-sm">
          {props.item.convertedText}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <span className="eyebrow">채널 텍스트 · {props.item.channel}</span>
          {dirty && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-ink" />
              편집 중
            </span>
          )}
        </div>
        <textarea
          className="min-h-64 w-full resize-y rounded-xl border border-line bg-surface p-4 text-[15px] leading-relaxed text-ink shadow-sm outline-none transition-colors focus:border-mint focus:ring-4 focus:ring-mint/10"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg disabled:opacity-40"
          disabled={busy || !dirty}
          onClick={() =>
            run(async () => {
              // Adopt the value the server actually stored: a save that canonicalises back to
              // the already-stored string would otherwise never change props.item.text, so the
              // effect below would never fire and local `text` would stay dirty forever.
              const saved = await props.onSave(props.item, text);
              if (saved !== undefined) setText(saved);
            })
          }
        >
          저장
        </button>
        {props.item.status === "approved" ? (
          <span className="inline-flex items-center rounded-lg bg-mint-soft px-3.5 py-1.5 text-[13px] font-medium text-mint">
            승인됨 ✓
          </span>
        ) : (
          <button
            className="rounded-lg bg-mint px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-mint-hover disabled:opacity-40"
            disabled={busy || dirty}
            onClick={() => run(() => props.onApprove(props.item))}
            title={dirty ? "편집 내용을 먼저 저장하세요" : undefined}
          >
            승인하기
          </button>
        )}
      </div>

      {emissionsError && (
        <p className="mt-6 text-[13px] text-red-600">
          목적지별 출력을 불러오지 못했습니다. 항목을 다시 선택하면 다시 시도합니다.
        </p>
      )}

      {tab && (
        <section className="mt-8 border-t border-line pt-5">
          <div className="eyebrow mb-2.5">목적지별 출력</div>
          <div className="mb-3 inline-flex flex-wrap gap-0.5 rounded-lg border border-line bg-bg p-0.5">
            {(Object.keys(emissions) as Destination[]).map((d) => (
              <button
                key={d}
                onClick={() => setTab(d)}
                className={`rounded-[7px] px-3 py-1 text-[12px] font-medium transition-colors ${
                  d === tab ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {DESTINATION_LABEL[d]}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2.5">
            {emissions[tab]?.segments.map((s, i) => {
              const pct = s.limit > 0 ? Math.min(100, Math.round((s.length / s.limit) * 100)) : 0;
              return (
                <div key={i} className="rounded-xl border border-line bg-surface p-3 shadow-sm">
                  <div className="mb-2 flex items-center gap-2.5 text-[12px]">
                    {s.label && <span className="font-medium text-muted">{s.label}</span>}
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`font-mono tabular-nums ${s.overLimit ? "font-semibold text-red-600" : "text-faint"}`}
                      >
                        {s.length}/{s.limit}
                      </span>
                      <span className="h-1 w-14 overflow-hidden rounded-full bg-line">
                        <span
                          className={`block h-full rounded-full ${s.overLimit ? "bg-red-500" : "bg-mint"}`}
                          style={{ width: `${s.overLimit ? 100 : pct}%` }}
                        />
                      </span>
                    </div>
                    <button
                      className="ml-auto rounded-md border border-line bg-surface px-2.5 py-0.5 text-[12px] font-medium text-ink transition-colors hover:bg-bg"
                      onClick={() => copy(`${tab}:${i}`, s.text)}
                    >
                      {copiedKey === `${tab}:${i}` ? "복사됨 ✓" : "복사"}
                    </button>
                  </div>
                  <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink/80">{s.text}</div>
                </div>
              );
            })}
          </div>

          {(emissions[tab]?.segments.length ?? 0) > 1 && (
            <button
              className="mt-3 rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-bg"
              onClick={() => copy(`${tab}:all`, emissions[tab]!.segments.map((s) => s.text).join("\n\n"))}
            >
              {copiedKey === `${tab}:all` ? "전체 복사됨 ✓" : "전체 복사"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
