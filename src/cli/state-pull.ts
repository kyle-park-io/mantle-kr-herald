import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { createDb } from "../adapters/db/createDb";
import { PullState } from "../app/PullState";
import { loadGoogleAuthConfig, loadGoogleStateFolder, loadDbConfig } from "../config";
import { paths } from "../paths";
import { createStateFileStore, describeKeptFiles, describeStateDiff, DRIVE_LABEL } from "./stateFiles";

const folderId = loadGoogleStateFolder();
if (!folderId) throw new Error("GDRIVE_STATE_FOLDER_ID 를 설정하세요 (`pnpm state:push` 를 한 번 돌리면 폴더를 만들고 id를 알려줍니다).");

// Opt IN to writing, not out of it. `config:pull` takes --dry-run because pulling is what it is for;
// here the pull overwrites a record of live sends, so the flagless run only ever previews.
const apply = process.argv.includes("--yes");
const auth = await createGoogleAuth(loadGoogleAuthConfig());

const drive = new GoogleConfigDrive(auth, fetch, DRIVE_LABEL);
const db = createDb(loadDbConfig());
try {
  const res = await new PullState(createStateFileStore(db), drive, paths.archiveDir).run(folderId, { apply });

  if (!res) {
    console.log("Drive에 운영 상태 스냅샷이 없습니다 — 먼저 `pnpm state:push` 를 돌리세요");
  } else {
    console.log(`스냅샷: ${res.snapshot}`);
    for (const l of describeStateDiff(res.diff)) console.log(l);
    if (!res.applied) {
      console.log("\n미리보기입니다 — 아무것도 쓰지 않았습니다. 위 내용대로 덮어쓰려면 `pnpm state:pull --yes` 로 다시 실행하세요.");
      console.log("주의: 이 파일들은 '이 기기가 무엇을 이미 보냈는가'의 기록입니다. 남의 스냅샷을 덮어쓰면 이미 나간 글이 미발송으로 보입니다.");
    } else {
      console.log(`\n${res.restored}개 파일을 복원했습니다${res.backedUp > 0 ? ` — 기존 ${res.backedUp}개는 ${res.backupDir} 에 백업했습니다` : ""}`);
      const kept = describeKeptFiles(res.diff);
      if (kept) console.warn(kept);
    }
  }
} finally {
  await db.close();
}
