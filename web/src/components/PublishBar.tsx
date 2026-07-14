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
      setResult(`업로드 ${r.uploaded} · 실패 ${r.failed}`);
    } catch (e) {
      setResult(`오류: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="publishbar">
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="google">google</option>
        <option value="lark">lark</option>
        <option value="both">both</option>
      </select>
      <button className="btn" disabled={busy} onClick={publish}>
        발행 ⬆
      </button>
      {result && <span className="publish-result">{result}</span>}
    </div>
  );
}
