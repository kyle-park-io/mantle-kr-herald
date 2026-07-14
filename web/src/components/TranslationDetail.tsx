import { useEffect, useState } from "react";
import type { Translation } from "../types";

export function TranslationDetail(props: {
  item: Translation;
  onSave: (id: string, koreanText: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
}) {
  const [korean, setKorean] = useState(props.item.koreanText);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKorean(props.item.koreanText), [props.item.itemId, props.item.koreanText]);

  const dirty = korean !== props.item.koreanText;
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
      <div className="detail-head">
        <code>{props.item.itemId}</code>
        <span className={`badge badge-${props.item.status}`}>{props.item.status}</span>
      </div>
      <h3>원문 (source)</h3>
      <div className="source">{props.item.sourceText}</div>
      <h3>한글 (Korean){dirty ? " • 편집중" : ""}</h3>
      <textarea value={korean} onChange={(e) => setKorean(e.target.value)} />
      <div className="detail-actions">
        <button className="btn" disabled={busy || !dirty} onClick={() => run(() => props.onSave(props.item.itemId, korean))}>
          저장
        </button>
        <button className="btn btn-primary" disabled={busy || dirty} onClick={() => run(() => props.onApprove(props.item.itemId))}>
          승인 ✓
        </button>
      </div>
    </div>
  );
}
