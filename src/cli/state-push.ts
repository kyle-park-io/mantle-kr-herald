import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { createDb } from "../adapters/db/createDb";
import { PushState } from "../app/PushState";
import { loadGoogleAuthConfig, loadGoogleStateFolder, loadDbConfig } from "../config";
import { createStateFileStore, describeProvisionedFolder, DRIVE_LABEL } from "./stateFiles";
import { describeBackupTarget } from "../domain/state/target";

// Sibling of steering-config under the same parent (review · approved · steering-config ·
// operational-state), but a folder of its own: this one is a record of what THIS machine has sent,
// and it must not be handed to the team the way the steering corpus is.
const STATE_FOLDER_NAME = "operational-state";
const PARENT_FOLDER_NAME = process.env.GDRIVE_PARENT_FOLDER_NAME?.trim() || "Mantle KR Herald";
const auth = await createGoogleAuth(loadGoogleAuthConfig());

let folderId = loadGoogleStateFolder();
if (!folderId) {
  const prov = new GoogleDriveProvisioner(auth);
  const parent = await prov.findFolder(PARENT_FOLDER_NAME); // undefined → fall back to the drive root
  // Say which of the two actually happened. The found-not-created branch is the `.env`-lost-but-
  // Drive-intact recovery, an ordinary path for this command — and being told a folder full of
  // months of snapshots was just "created" is exactly the wrong signal there.
  const existing = await prov.findFolder(STATE_FOLDER_NAME, parent?.id);
  const found = existing ?? (await prov.createFolder(STATE_FOLDER_NAME, parent?.id));
  folderId = found.id;
  console.log(describeProvisionedFolder({ created: !existing, name: found.name, id: found.id, parentName: parent?.name }));
  console.log(`.env 에 추가하세요:  GDRIVE_STATE_FOLDER_ID=${found.id}`);
}

const drive = new GoogleConfigDrive(auth, fetch, DRIVE_LABEL);
const dbConfig = loadDbConfig();
for (const line of describeBackupTarget(dbConfig)) console.log(line);
const db = createDb(dbConfig);
try {
  // `assertRestorable` belongs here and only here: this is the one command that puts a snapshot in
  // Drive, and the refusal exists to keep what lands there applicable more than once. `state:pull`
  // must be able to READ a corpus holding an itemId-less row — see `SnapshotOptions`.
  const res = await new PushState(createStateFileStore(db, { assertRestorable: true }), drive).run(folderId);
  if (!res) {
    console.log("백업할 운영 상태 데이터가 없습니다 — 아직 포크·발송 기록이 하나도 없는 데이터베이스입니다. 올린 것 없음.");
  } else {
    console.log(`${res.files.length}개 파일을 올렸습니다 → ${res.name} (${res.id})`);
    for (const f of res.files) console.log(`  ${f.path} — ${f.rows === undefined ? "행 수 알 수 없음" : `${f.rows}행`}`);
  }
} finally {
  await db.close();
}
