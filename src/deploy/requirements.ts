import type { CheckResult } from "../doctor/report";

/**
 * One environment-variable expectation the Vercel production deployment holds, independent of
 * whether it is currently met. `severity` is what a violation becomes — `fail` for the eight
 * `assert*` startup guards in `api/[...path].ts` (`.env.example` §6, "refuses to start"), `warn`
 * for everything that boots but degrades in silence (the §3/§4 groups `.env.example` §6 calls
 * "starts fine and is quietly wrong"). `consequence` is written for the operator reading
 * `pnpm deploy:*` output, not for a developer reading this file — see `.env.example` §6 and
 * `docs/ko/setup/vercel.md` §4, which this reuses rather than re-deriving.
 */
export interface EnvExpectation {
  name: string;
  severity: "fail" | "warn";
  consequence: string;
}

/**
 * Names the deployment must have set. The eight `fail` entries are `.env.example` §6's "refuses to
 * start" list (§1's `DATABASE_URL`/`HERALD_DB_ENV`, §5's auth trio, and the three §6-only values);
 * everything else is a `warn` entry from §3/§4 — present in a healthy install, but its absence never
 * stops the function from booting, only quietly turns a feature off (a Telegram-only install with no
 * Google Drive credentials is a legitimate deployment, not a broken one).
 */
export const MUST_BE_SET: readonly EnvExpectation[] = [
  {
    name: "DATABASE_URL",
    severity: "fail",
    consequence: "함수가 뜨지 않습니다 — 파이프라인의 모든 기록(번역, 변환, 렌더링, 발송 이력)을 저장하는 Postgres 접속 문자열이 없습니다.",
  },
  {
    name: "HERALD_DB_ENV",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — `loadDbEnv()`가 이 값 없이는 예외를 던집니다. `DATABASE_URL`이 가리키는 곳이 운영 DB인지 개인 스크래치 DB인지는 접속 문자열만 보고는 구분할 수 없어, 값을 추측하지 않고 반드시 명시하게 합니다.",
  },
  {
    name: "HERALD_STORAGE_MODE",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — 반드시 `cloud`여야 합니다. `local`이면 승인 문서가 함수의 임시 파일시스템에 쓰여 업로드는 성공했다고 보고하지만 인스턴스가 사라지면 링크가 전부 죽고, 이를 `assertCloudStorage`가 기동 단계에서 거부합니다.",
  },
  {
    name: "HERALD_AUTH_USERNAME",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — 대시보드의 단일 로그인 계정입니다. POST /api/login을 제외한 모든 라우트가 이 계정이 여는 세션 뒤에 있어, 계정이 없으면 안전하게 서비스할 방법이 없습니다.",
  },
  {
    name: "HERALD_AUTH_PASSWORD_HASH",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — `HERALD_AUTH_USERNAME`과 짝을 이루는 scrypt 해시입니다. `pnpm auth:hash`로 생성하며, 이 값이 없으면 로그인 계정 자체가 성립하지 않습니다.",
  },
  {
    name: "HERALD_SESSION_SECRET",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — 로그인 성공 후 세션 쿠키에 서명(HMAC-SHA256)하는 값입니다. 없으면 로그인이 성공해도 세션을 발급할 방법이 없습니다.",
  },
  {
    name: "HERALD_TRUST_PROXY",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — 반드시 `true`여야 합니다. Vercel Function에는 `pnpm serve`가 가진 것 같은 로 소켓이 없어, 이 값 없이는 모든 요청이 '믿을 만한 주소 없음'으로 풀려 주소별 로그인 잠금이 키를 얻지 못하고 전역 50회 백스톱만 남습니다 — 바깥의 한 사람이 팀 전체 로그인을 조용히 막을 수 있어, `assertTrustProxy`가 그 상태로 서비스하느니 기동을 거부합니다.",
  },
  {
    name: "HERALD_DEPLOYMENT_ORIGIN",
    severity: "fail",
    consequence:
      "함수가 뜨지 않습니다 — CSRF 가드(`refusalReason`)가 비교할 배포 오리진입니다. 기본 `*.vercel.app` 도메인은 배포되기 전까지 존재하지 않으므로 유추하거나 관대한 기본값을 두지 않고, 없으면 상태를 바꾸는 모든 요청을 거부합니다.",
  },
  {
    name: "GOOGLE_AUTH_MODE",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 에러 없이 대시보드 버튼만 비활성화됩니다. `createDeps`가 이 설정 실패를 try/catch로 삼키기 때문입니다.",
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_ID",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 에러 없이 대시보드 버튼만 비활성화됩니다. `createDeps`가 이 설정 실패를 try/catch로 삼키기 때문입니다.",
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_SECRET",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 에러 없이 대시보드 버튼만 비활성화됩니다. `createDeps`가 이 설정 실패를 try/catch로 삼키기 때문입니다.",
  },
  {
    name: "GOOGLE_OAUTH_REFRESH_TOKEN",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 에러 없이 대시보드 버튼만 비활성화됩니다. `createDeps`가 이 설정 실패를 try/catch로 삼키기 때문입니다.",
  },
  {
    name: "GDRIVE_REVIEW_FOLDER_ID",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 검토 폴더 id가 없으면 `createDeps`가 이 타깃을 건너뛰고, 대시보드는 저장소 모드 배지의 호버 카드에 '키 없음'이라고만 표시합니다.",
  },
  {
    name: "GDRIVE_APPROVED_FOLDER_ID",
    severity: "warn",
    consequence: "google 발행 타깃이 조용히 사라집니다 — 승인 폴더 id가 없으면 `createDeps`가 이 타깃을 건너뛰고, 대시보드는 저장소 모드 배지의 호버 카드에 '키 없음'이라고만 표시합니다.",
  },
  {
    name: "GDRIVE_SENT_FOLDER_ID",
    severity: "warn",
    consequence: "발송 후 Google Drive 보관용 사본이 저장되지 않습니다 — 발송 자체는 영향받지 않습니다.",
  },
  {
    name: "LARK_APP_ID",
    severity: "warn",
    consequence: "lark 발행 타깃이 조용히 사라집니다 — google과 마찬가지로 에러 없이 대시보드 버튼만 비활성화됩니다.",
  },
  {
    name: "LARK_APP_SECRET",
    severity: "warn",
    consequence: "lark 발행 타깃이 조용히 사라집니다 — google과 마찬가지로 에러 없이 대시보드 버튼만 비활성화됩니다.",
  },
  {
    name: "LARK_WORKSPACE_URL",
    severity: "warn",
    consequence: "대시보드에 Lark 폴더/파일 열기 링크가 보이지 않게 됩니다 — 이 값은 링크 생성에만 쓰여 게시 자체에는 영향이 없습니다.",
  },
  {
    name: "LARK_DRIVE_REVIEW_FOLDER_TOKEN",
    severity: "warn",
    consequence: "lark 발행 타깃이 조용히 사라집니다 — google과 마찬가지로 에러 없이 대시보드 버튼만 비활성화됩니다.",
  },
  {
    name: "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
    severity: "warn",
    consequence: "lark 발행 타깃이 조용히 사라집니다 — google과 마찬가지로 에러 없이 대시보드 버튼만 비활성화됩니다.",
  },
  {
    name: "LARK_DRIVE_SENT_FOLDER_TOKEN",
    severity: "warn",
    consequence: "발송 후 Lark Drive 보관용 사본이 저장되지 않습니다 — 발송 자체는 영향받지 않습니다.",
  },
  {
    name: "TELEGRAM_BOT_TOKEN",
    severity: "warn",
    consequence: "지금은 기동에 영향이 없지만, §6에서 발송(`HERALD_SENDS_ENABLED=true`)을 여는 순간 Telegram으로 보내는 발송이 실패합니다.",
  },
  {
    name: "TELEGRAM_CHAT_ID_COMMUNITY",
    severity: "warn",
    consequence: "지금은 기동에 영향이 없지만, §6에서 발송을 여는 순간 커뮤니티 방(맨틀 한국 커뮤니티)으로 보내는 발송이 실패합니다.",
  },
  {
    name: "TELEGRAM_CHAT_ID_DEV",
    severity: "warn",
    consequence: "지금은 기동에 영향이 없지만, §6에서 발송을 여는 순간 데브 방(맨틀 한국 데브방)으로 보내는 발송이 실패합니다.",
  },
  {
    name: "TYPEFULLY_API_KEY",
    severity: "warn",
    consequence: "지금은 기동에 영향이 없지만, §6에서 발송을 여는 순간 X(Typefully)로 보내는 발송이 실패합니다.",
  },
  {
    name: "TYPEFULLY_SOCIAL_SET_ID",
    severity: "warn",
    consequence: "지금은 기동에 영향이 없지만, §6에서 발송을 여는 순간 X(Typefully)로 보내는 발송이 실패합니다.",
  },
  {
    name: "X_PREMIUM",
    severity: "warn",
    consequence:
      "값이 없으면 기본값 false로 취급되어 표준 280자 가중치 제한(한글/이모지는 2자로 계산)이 적용됩니다 — 계정에 실제로는 X Premium이 있는데 이 값을 옮기지 않으면 로컬에서 통과하던 롱폼 트윗이 첫 발송에서 거부되고, X 발행 쿼터가 월 15건뿐이라 디버깅 비용이 그대로 실제 쿼터로 나갑니다.",
  },
  {
    name: "GSHEET_ID",
    severity: "warn",
    consequence: "대시보드 헤더의 시트 링크가 사라집니다 — 게시나 발송 자체에는 영향이 없습니다.",
  },
  {
    name: "GSHEET_QA_ID",
    severity: "warn",
    consequence: "대시보드 헤더의 QA 시트 링크가 사라집니다 — 팀이 QA 시트로 이동할 방법이 하나 줄어들 뿐, 다른 기능에는 영향이 없습니다.",
  },
];

/**
 * Names the deployment must NOT have set. `.env.example` §6's own two cases: a local file path
 * that can never resolve inside the function (`fail` — present is a mistake, not a preference), and
 * the flag that reopens sends the hosted board deliberately ships with closed (`warn` — present this
 * early skips the step-6 decision to open it, but does not itself break anything running today).
 */
export const MUST_BE_ABSENT: readonly EnvExpectation[] = [
  {
    name: "GOOGLE_SA_KEY_FILE",
    severity: "fail",
    consequence:
      "이 값은 옮기면 안 됩니다 — 로컬 파일 경로(예: keys/mantle-sa.json)라 함수에는 그 파일이 없습니다. 값이 있으면 서비스 계정 인증이 존재하지 않는 키 파일을 찾다가 실패합니다.",
  },
  {
    name: "HERALD_SENDS_ENABLED",
    severity: "warn",
    consequence:
      "호스팅 대시보드는 발송을 닫은 채로 첫 배포되는 것이 의도입니다 — 이 값이 이미 설정돼 있으면 1차/2차 승인 검증 없이 실제 발송이 열립니다. 팀이 준비됐다고 판단한 뒤 §6에서 명시적으로 여세요.",
  },
];

/**
 * Checks only variable *names* — never values — against `MUST_BE_SET`/`MUST_BE_ABSENT`. One
 * `CheckResult` per expectation, in list order, and nothing else: a name present in `present` that
 * appears in neither list (Neon injects roughly sixteen of these — `PGHOST`, `POSTGRES_URL`, etc.)
 * produces no result at all, because this function has no opinion about it.
 */
export function checkEnvNames(present: readonly string[]): CheckResult[] {
  const has = new Set(present);
  const results: CheckResult[] = [];

  for (const { name, severity, consequence } of MUST_BE_SET) {
    if (has.has(name)) {
      results.push({ name, status: "ok", detail: `${name} 설정됨` });
    } else {
      results.push({ name, status: severity, detail: consequence });
    }
  }

  for (const { name, severity, consequence } of MUST_BE_ABSENT) {
    if (has.has(name)) {
      results.push({ name, status: severity, detail: consequence });
    } else {
      results.push({ name, status: "ok", detail: `${name} 미설정 (정상)` });
    }
  }

  return results;
}
