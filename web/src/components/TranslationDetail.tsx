import { useEffect, useState } from "react";
import type { Translation, PublishStateRow } from "../types";

const badgeClass = (status: Translation["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

export function TranslationDetail(props: {
  item: Translation;
  publishRows: PublishStateRow[];
  onSave: (id: string, koreanText: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { onDirtyChange } = props;
  const [korean, setKorean] = useState(props.item.koreanText);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKorean(props.item.koreanText), [props.item.itemId, props.item.koreanText]);

  const dirty = korean !== props.item.koreanText;
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
        <code className="text-sm">{props.item.itemId}</code>
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${badgeClass(props.item.status)}`}>{props.item.status}</span>
      </div>
      <h3 className="font-semibold text-neutral-700 mb-1">원문 (source)</h3>
      <div className="whitespace-pre-wrap text-sm mb-4">{props.item.sourceText}</div>
      <h3 className="font-semibold text-neutral-700 mb-1">한글 (Korean){dirty ? " • 편집중" : ""}</h3>
      <textarea
        className="w-full min-h-56 text-sm p-2 border border-neutral-300 rounded"
        value={korean}
        onChange={(e) => setKorean(e.target.value)}
      />
      <div className="flex gap-2.5 mt-3">
        <button
          className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white disabled:opacity-50"
          disabled={busy || !dirty}
          onClick={() => run(() => props.onSave(props.item.itemId, korean))}
        >
          저장
        </button>
        <button
          className="px-3.5 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-50"
          disabled={busy || dirty}
          onClick={() => run(() => props.onApprove(props.item.itemId))}
        >
          승인 ✓
        </button>
      </div>
      <div className="mt-6 border-t border-neutral-200 pt-3">
        <h3 className="text-xs font-semibold text-neutral-500 mb-1.5">발행 상태</h3>
        {props.publishRows.length === 0 ? (
          <p className="text-xs text-neutral-400">아직 발행되지 않음</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {props.publishRows.map((r) => (
              <li key={`${r.status}:${r.target}`} className="flex items-center gap-2 text-xs">
                <span className="text-neutral-500">{r.status} · {r.target}</span>
                {r.target === "local" && r.remoteId ? (
                  <a className="text-indigo-600 hover:underline" href={`/api/publish/local/${r.remoteId.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">열기</a>
                ) : r.url ? (
                  <a className="text-indigo-600 hover:underline" href={r.url} target="_blank" rel="noreferrer">Drive에서 열기</a>
                ) : (
                  <span className="text-neutral-400">링크 없음</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
