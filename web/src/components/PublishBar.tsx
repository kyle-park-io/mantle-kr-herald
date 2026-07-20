import { useEffect, useState } from "react";
import { api } from "../api";
import type { StorageMode } from "../types";

/** local mode publishes to disk, so offering a cloud target there would fail on every click. */
const targetsFor = (mode: StorageMode): string[] =>
  mode === "local" ? ["local"] : ["google", "lark", "both", "local"];

export function PublishBar() {
  const [mode, setMode] = useState<StorageMode | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setMode(c.storageMode);
        setTarget(targetsFor(c.storageMode)[0]);
      })
      .catch((e) => setResult(`오류: ${(e as Error).message ?? e}`));
  }, []);

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
        disabled={mode === null}
        onChange={(e) => setTarget(e.target.value)}
      >
        {mode !== null &&
          targetsFor(mode).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
      </select>
      <button
        className="px-3 py-1 rounded-md border border-white/30 text-sm disabled:opacity-50"
        disabled={busy || mode === null}
        onClick={publish}
      >
        발행 ⬆
      </button>
      {result && <span className="text-xs font-normal">{result}</span>}
    </div>
  );
}
