import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { PushState } from "../app/PushState";
import { loadGoogleAuthConfig, loadGoogleStateFolder } from "../config";
import { createStateFileStore } from "./stateFiles";

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
  const found =
    (await prov.findFolder(STATE_FOLDER_NAME, parent?.id)) ?? (await prov.createFolder(STATE_FOLDER_NAME, parent?.id));
  folderId = found.id;
  console.log(`운영 상태 폴더 "${found.name}"${parent ? ` (상위: "${parent.name}")` : ""} 를 만들었습니다 — ${found.id}`);
  console.log(`.env 에 추가하세요:  GDRIVE_STATE_FOLDER_ID=${found.id}`);
}

const res = await new PushState(createStateFileStore(), new GoogleConfigDrive(auth)).run(folderId);
if (!res) {
  console.log("백업할 운영 상태 파일이 없습니다 — 아직 포크·발송 기록이 하나도 없는 작업 트리입니다. 올린 것 없음.");
} else {
  console.log(`${res.files.length}개 파일을 올렸습니다 → ${res.name} (${res.id})`);
  for (const f of res.files) console.log(`  ${f.path} — ${f.rows === undefined ? "행 수 알 수 없음" : `${f.rows}행`}`);
}
