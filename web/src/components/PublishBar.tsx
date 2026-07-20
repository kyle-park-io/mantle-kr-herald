import { useState } from "react";
import { api } from "../api";

export function PublishBar() {
  const [target, setTarget] = useState("google");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.publish(target);
      setResult(`업로드 ${r.uploaded} · 갱신 ${r.updated} · 실패 ${r.failed}`);
    } catch (e) {
      setResult(`오류: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <select
        className="text-neutral-900 text-sm rounded px-1.5 py-1"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="google">google</option>
        <option value="lark">lark</option>
        <option value="both">both</option>
      </select>
      <button
        className="px-3 py-1 rounded-md border border-white/30 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={publish}
      >
        발행 ⬆
      </button>
      {result && <span className="text-xs font-normal">{result}</span>}
    </div>
  );
}
