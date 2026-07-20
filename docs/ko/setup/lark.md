# Lark 셋업 가이드 (앱 + Drive) — 값 발급/확인하기

> **하나의 Lark 앱**으로 두 서브시스템을 다룹니다:
> - **§0–§9 — 서브시스템 B(Lark 데이터 수집)**: `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS`, (선택) `LARK_BASE_URL`
> - **§10 — 서브시스템 D(Lark Drive 업로드)**: 같은 앱에 Drive 스코프 추가 + `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN`
>
> (Google Drive는 별도 플랫폼 — `google-drive.md` 참고.)
> 콘솔의 메뉴 명칭은 언어(한/영/중) 설정과 버전에 따라 조금씩 다를 수 있습니다.

---

## 0. 먼저: 리전(Larksuite vs Feishu)

| 리전 | 개발자 콘솔 | API 도메인 | `LARK_BASE_URL` |
| --- | --- | --- | --- |
| **Larksuite (국제판)** | https://open.larksuite.com/app | `https://open.larksuite.com` | 비워두면 기본값 |
| Feishu (중국판) | https://open.feishu.cn/app | `https://open.feishu.cn` | `https://open.feishu.cn` |

Mantle KR은 보통 **Larksuite 국제판**입니다. 팀이 쓰는 Lark가 어느 쪽인지 확인하세요.
(둘은 계정·데이터가 분리돼 있어 서로 호환되지 않습니다.)

---

## 1. 커스텀 앱 생성 → App ID / App Secret

1. **개발자 콘솔** 접속: https://open.larksuite.com/app (관리자 권한 또는 앱 생성 권한 필요)
2. **Create Custom App**(커스텀 앱 만들기) 클릭 → 이름/설명 입력 후 생성
3. 생성된 앱으로 들어가서 왼쪽 메뉴 **Credentials & Basic Info**(기본 정보/凭证与基础信息)
4. 여기에 **App ID**와 **App Secret**이 있습니다.
   - `App ID` → `.env`의 `LARK_APP_ID`
   - `App Secret` → `.env`의 `LARK_APP_SECRET`  ⚠️ 시크릿이니 절대 공유·커밋 금지

---

## 2. 봇 기능 활성화

메시지를 읽으려면 앱에 **봇(Bot)** 이 있어야 대상 그룹에 추가할 수 있습니다.

1. 앱 → 왼쪽 메뉴 **Features → Bot**(기능 → 봇)
2. **Enable Bot** 활성화 후 저장

---

## 3. 권한(스코프) 승인

앱 → **Permissions & Scopes**(권한 관리/权限管理)에서 아래를 추가합니다.

| 스코프 | 용도 | 필수? |
| --- | --- | --- |
| `im:message.group_msg` | 봇이 속한 그룹의 **모든 메시지 읽기** (수집 런타임, `GET /im/v1/messages?container_id_type=chat`) | ✅ 필수 (민감 권한) |
| `im:chat:readonly` | 봇이 속한 **그룹 목록·chat_id** 조회 (chat_id 확인용) | 권장(§6에서 사용) |
| `drive:drive` (또는 `drive:file`) | **Lark Drive 업로드** (서브시스템 D) | D 쓸 때(§10) |

> ⚠️ 그룹 메시지 수집(`GET /open-apis/im/v1/messages`)에는 **`im:message.group_msg`** 가 반드시 필요합니다.
> 이건 **민감 권한**이라 조직 **관리자 승인**이 필요할 수 있어요. 없으면 API가
> `code 230027 "Lack of necessary permissions … need scope: im:message.group_msg"` 로 거부합니다(수집 0건 + 실패).
> `im:message.history:readonly` / `im:message:readonly` 만으로는 그룹 히스토리 조회가 거부될 수 있으니 위 스코프를 꼭 추가하세요.
> (참고: 봇으로 **그룹 생성·메시지 전송**까지 API로 하려면 `im:chat`(쓰기)·`im:message:send_as_bot`도 필요하지만, 수집만 할 거면 불필요. Drive(D)를 안 쓰면 `drive:*`는 생략 가능.)

---

## 4. 앱 버전 릴리스(승인)

커스텀 앱은 **버전을 만들어 릴리스(테넌트 승인)** 해야 스코프·봇이 실제로 적용됩니다.

1. 앱 → **Version Management & Release**(버전 관리/发布) → **Create Version**
2. 제출 → 조직 관리자 승인(본인이 관리자면 바로 승인). 승인 후 스코프가 유효해집니다.

> 스코프를 추가/변경할 때마다 **새 버전 릴리스가 필요**할 수 있습니다.

---

## 5. 봇을 대상 그룹에 추가

수집하려는 각 그룹(예: **Mantle News Announcement**, **MKT Task 2.0**)에 봇을 넣습니다.

1. Lark 앱에서 대상 **그룹 채팅** 열기
2. 우측 상단 **그룹 설정(Settings)** → **Bots / Group Bots**(그룹 봇) → **Add Bot**
3. 방금 만든 앱(봇)을 검색해 추가

> 봇이 그룹에 없으면 메시지 조회 시 권한/멤버 오류가 납니다.

---

## 6. chat_id 확인 (가장 헷갈리는 부분)

`chat_id`는 UI에 잘 안 보입니다. **API Explorer**로 봇이 속한 그룹 목록을 조회하는 게 가장 확실해요.

**방법 A — API Explorer (권장, 코드 불필요)**

1. 개발자 콘솔 → **API Explorer**(調試台/디버깅 콘솔) 열기
2. 상단에서 방금 만든 **앱 선택**, 토큰 타입 **tenant_access_token** 선택 (Explorer가 자동 발급)
3. 엔드포인트 호출: **`GET /open-apis/im/v1/chats`** (Get the list of groups that a bot/app belongs to)
4. 응답 `data.items[]`에서 각 그룹의 **`chat_id`** 와 **`name`** 확인
   - 대상 그룹 이름과 매칭되는 `chat_id`를 복사

**방법 B — 직접 호출(curl)**

```bash
# 1) 토큰 발급
TOKEN=$(curl -s -X POST https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"<APP_ID>","app_secret":"<APP_SECRET>"}' | jq -r .tenant_access_token)

# 2) 봇이 속한 그룹 목록 → chat_id 확인
curl -s "https://open.larksuite.com/open-apis/im/v1/chats?page_size=100" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.items[] | {chat_id, name}'
```

응답 예시:

```json
{ "chat_id": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxx", "name": "Mantle News Announcement" }
```

- 여기서 `chat_id`(보통 `oc_`로 시작)를 `.env`의 `LARK_CHAT_IDS`에 넣습니다.
- **그룹이 여러 개면 콤마로**: `LARK_CHAT_IDS=oc_aaa,oc_bbb`

> 봇이 그룹에 없으면 그 그룹은 목록에 안 나옵니다 → §5를 먼저 완료하세요.

---

## 7. `.env` 채우기

프로젝트 루트에 `.env` (없으면 `cp .env.example .env`) — `.env`는 git에 커밋되지 않습니다.

```bash
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LARK_CHAT_IDS=oc_xxxxxxxx,oc_yyyyyyyy
# LARK_BASE_URL=          # Larksuite면 비워둠. Feishu면 https://open.feishu.cn
```

---

## 8. 빠른 검증

- 위 curl §6이 `chat_id`를 돌려주면 인증·권한·봇 멤버십이 정상이라는 뜻입니다.
- 메시지가 실제로 읽히는지 API Explorer에서 확인:
  **`GET /open-apis/im/v1/messages?container_id_type=chat&container_id=<chat_id>&page_size=5`**
  → `data.items[]`에 메시지가 나오면 수집 준비 완료.
- 코드가 준비되면: `pnpm collect-lark` (또는 라이브 probe 테스트)로 실검증.

---

## 9. 자주 나는 오류

| 증상 | 원인 / 해결 |
| --- | --- |
| `code 99991663` / token invalid | App ID/Secret 오타, 또는 리전 불일치(Larksuite↔Feishu). §0·§1 확인 |
| `permission denied` / 스코프 오류 | 스코프 미승인 또는 **버전 릴리스 안 함**. §3·§4 확인 |
| `code 230027` / `need scope: im:message.group_msg` | 그룹 메시지 읽기 스코프 미승인. §3에서 **`im:message.group_msg`** 추가 → 버전 릴리스(§4) → 재시도 |
| chat 목록/메시지에 그룹이 안 보임 | 봇이 그룹에 없음. §5에서 봇 추가 |
| 메시지는 되는데 텍스트가 비어 보임 | `body.content`는 타입별 JSON. 수집기는 text/post를 평문으로 추출(설계 §4) |

---

## 10. Lark Drive 업로드 (서브시스템 D)

번역 결과를 Lark Drive에 올리는 서브시스템 D는 **위에서 만든 같은 앱**을 재사용합니다
(`LARK_APP_ID`/`LARK_APP_SECRET`/`LARK_BASE_URL` 그대로). 추가로 필요한 것만 아래에.

### 10-1. Drive 스코프 추가 → 버전 릴리스

§3의 im 스코프에 더해 **Permissions & Scopes**에서 아래 중 하나를 추가하고, **§4처럼 새 버전을 릴리스(승인)**:

| 스코프 | 용도 |
| --- | --- |
| **`drive:drive`** | 클라우드 문서 전체 관리 (권장) |
| `drive:file` | 파일 업로드/다운로드 (더 좁은 권한) |

### 10-2. review / approved 폴더 만들고 앱과 공유

Lark Drive에서 폴더 **2개**(예: 검수·승인) 생성 → 각 폴더를 **앱(봇)이 접근 가능하도록 공유**.
(봇이 접근 못 하는 폴더엔 업로드 시 권한 오류가 납니다.)

### 10-3. 폴더 token 확보 → `LARK_DRIVE_*_FOLDER_TOKEN`

Lark의 `parent_node`는 **폴더 token**입니다. **폴더 URL에서 복사하는 것이 유일하게 확실한 방법**입니다:

- **폴더 URL에서 (권장)**: 폴더를 열면 주소가 `https://<도메인>.larksuite.com/drive/folder/**<FOLDER_TOKEN>**`
  형태 — `/drive/folder/` 뒤 값이 token (보통 `fldcn…` 또는 `nod…`로 시작). §10-2에서 봇과 공유한 그 폴더 2개의 URL에서 각각 복사하세요.

```bash
LARK_DRIVE_REVIEW_FOLDER_TOKEN=<검수 폴더 token>
LARK_DRIVE_APPROVED_FOLDER_TOKEN=<승인 폴더 token>
```

> **API로 "내 드라이브 목록"을 뽑아 token을 찾으려 하지 마세요 — 현재 구성으로는 안 됩니다.**
> `GET /open-apis/drive/v1/files`를 이 프로젝트의 앱 토큰(`tenant_access_token`)으로 부르면 두 가지 벽에 막힙니다:
> 1. **스코프 미승인** — drive 스코프가 없으면 `code 99991672 "Access denied. One of the following scopes is required: [drive:drive, drive:drive:readonly, space:document:retrieve]"`로 거부됩니다(§10-1에서 추가·릴리스 필요).
> 2. **스코프를 추가해도 개인 드라이브는 안 보임** — `tenant_access_token`은 **앱(봇) 신원**이라, 목록에 나오는 건 *앱이 만들었거나 앱에 공유된* 파일뿐입니다. 당신이 개인 "My Space"에 만든 폴더는 이 목록에 **나오지 않습니다**. (Google에서 서비스 계정으로 개인 Gmail 드라이브를 못 보는 것과 같은 구조 — `google-drive.md` 참고.)
>
> 그래서 위의 **폴더-URL 복사**가 정답입니다. 개인 폴더를 API로 나열하려면 `user_access_token`(OAuth 사용자 위임)이 필요한데, 이 프로젝트는 아직 Lark 쪽 OAuth를 구현하지 않았습니다 — **추후 추가되면 이 안내는 갱신될 수 있습니다.**

### 10-4. 검증 & 오류

```bash
pnpm probe tests/adapters/drive/drive.probe.test.ts   # .env 읽어 실업로드 probe (자격증명 있는 것만)
pnpm drive:publish --target lark
```

> `pnpm probe`는 `.env`를 로드합니다(일반 `pnpm test`는 안 읽어 skip). `LARK_APP_ID`/`LARK_APP_SECRET`/
> `LARK_DRIVE_REVIEW_FOLDER_TOKEN`이 모두 있으면 review 폴더에 throwaway `.md`를 실제 업로드해 봅니다.

| 증상 | 원인 / 해결 |
| --- | --- |
| `code 1061045` / no permission | drive 스코프 미승인 또는 **버전 릴리스 안 함**(§10-1), 폴더 미공유(§10-2) |
| 폴더에 안 보임 | `parent_node`(폴더 token) 오타 — 다른 폴더로 올라감(§10-3) |

---

**보안:** `App Secret`, `tenant_access_token`, `.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만
사용합니다(자동화 원칙).
