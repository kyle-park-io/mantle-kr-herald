import { useEffect, useState } from "react";
import type { Rendering } from "../types";

const badgeClass = (status: Rendering["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

export function RenderingDetail(props: {
  item: Rendering;
  onSave: (item: Rendering, text: string) => Promise<void>;
  onApprove: (item: Rendering) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { onDirtyChange } = props;
  const [text, setText] = useState(props.item.text);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3">
        <code className="text-sm">{props.item.itemId} · {props.item.type} · {props.item.channel}</code>
        <span className={`text-xs px-1.5 py-0.5 rounded ${badgeClass(props.item.status)}`}>{props.item.status}</span>
        {props.item.refined && <span className="text-xs text-neutral-400">refined</span>}
      </div>
      <h3 className="font-semibold text-neutral-700 mb-1">변환 원문 (converted)</h3>
      <div className="whitespace-pre-wrap text-base mb-4 text-neutral-600">{props.item.convertedText}</div>
      <h3 className="font-semibold text-neutral-700 mb-1">채널 텍스트 ({props.item.channel}){dirty ? " • 편집중" : ""}</h3>
      <textarea
        className="w-full min-h-56 text-base p-2 border border-neutral-300 rounded"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2.5 mt-3">
        <button
          className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white disabled:opacity-50"
          disabled={busy || !dirty}
          onClick={() => run(() => props.onSave(props.item, text))}
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
        <button className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white" onClick={copy}>
          {copied ? "복사됨 ✓" : "복사"}
        </button>
      </div>
    </div>
  );
}
