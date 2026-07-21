import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { DESTINATION_LABEL, renderingKey, type Destination, type Emissions, type Rendering } from "../types";

const badgeClass = (status: Rendering["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

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
    <div>
      <div className="flex items-center gap-2.5 mb-3">
        <code className="text-sm">{props.item.itemId} · {props.item.type} · {props.item.channel}</code>
        <span className={`text-xs px-1.5 py-0.5 rounded ${badgeClass(props.item.status)}`}>{props.item.status}</span>
        {props.item.refined && <span className="text-xs text-neutral-400">refined</span>}
      </div>
      <h3 className="text-lg font-semibold text-neutral-700 mb-1">변환 원문 (converted)</h3>
      <div className="whitespace-pre-wrap text-base mb-6 text-neutral-600">{props.item.convertedText}</div>
      <h3 className="text-lg font-semibold text-neutral-700 mb-1">채널 텍스트 ({props.item.channel}){dirty ? " • 편집중" : ""}</h3>
      <textarea
        className="w-full min-h-56 text-base p-2 border border-neutral-300 rounded"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2.5 mt-3">
        <button
          className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white disabled:opacity-50"
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
        <button
          className="px-3.5 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-50"
          disabled={busy || dirty}
          onClick={() => run(() => props.onApprove(props.item))}
        >
          승인 ✓
        </button>
      </div>
      {emissionsError && (
        <p className="mt-6 text-sm text-red-600">
          목적지별 출력을 불러오지 못했습니다. 항목을 다시 선택하면 다시 시도합니다.
        </p>
      )}
      {tab && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-neutral-700 mb-2">목적지별 출력</h3>
          <div className="flex gap-1.5 mb-3 flex-wrap">
            {(Object.keys(emissions) as Destination[]).map((d) => (
              <button
                key={d}
                className={`px-3 py-1 text-sm rounded-md border ${
                  d === tab ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-neutral-300"
                }`}
                onClick={() => setTab(d)}
              >
                {DESTINATION_LABEL[d]}
              </button>
            ))}
          </div>
          {emissions[tab]?.segments.map((s, i) => (
            <div key={i} className="mb-2 border border-neutral-200 rounded p-2">
              <div className="flex items-center gap-2 mb-1 text-sm">
                {s.label && <span className="text-neutral-500">{s.label}</span>}
                <span className={s.overLimit ? "text-red-600 font-semibold" : "text-neutral-500"}>
                  {s.length}/{s.limit}
                  {s.overLimit ? " ⚠" : ""}
                </span>
                <button
                  className="ml-auto px-2.5 py-0.5 border border-neutral-300 rounded bg-white text-sm"
                  onClick={() => copy(`${tab}:${i}`, s.text)}
                >
                  {copiedKey === `${tab}:${i}` ? "복사됨 ✓" : "복사"}
                </button>
              </div>
              <div className="whitespace-pre-wrap text-sm text-neutral-700">{s.text}</div>
            </div>
          ))}
          {(emissions[tab]?.segments.length ?? 0) > 1 && (
            <button
              className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white"
              onClick={() => copy(`${tab}:all`, emissions[tab]!.segments.map((s) => s.text).join("\n\n"))}
            >
              {copiedKey === `${tab}:all` ? "전체 복사됨 ✓" : "전체 복사"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
