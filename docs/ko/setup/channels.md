# 채널 발송 셋업 가이드 (§8 — Telegram + Typefully) — 값 발급/확인하기

> `pnpm send:channels`가 **승인된 렌더링**을 실제 채널로 발행하려면 `.env`에 자격증명이 필요합니다.
> **Telegram**(봇)과 **X**(Typefully) 두 채널 — 보내려는 채널의 값만 채우면 됩니다. 어느 저장 모드에서도
> 동작합니다(`skipIfLocal` 아님).
>
> **⚠️ 이 명령은 실제 채널에 공개 발행합니다.** metrics는 비공개 시트였지만 이건 공개 포스트입니다 —
> **첫 검증은 반드시 테스트 채널/테스트 X 계정**으로 하세요. 둘 다 무료로 검증할 수 있습니다.

---

## Telegram

### T-1. BotFather로 봇 생성 → 토큰

1. Telegram에서 **@BotFather** 검색 → `/newbot` → 이름 지정:
   - **표시 이름(name): `Mantle KR Herald`** (동의 화면 등에 보이는 이름 — 아무거나 돼도 이걸 권장)
   - **username: `mantle_kr_herald_bot`** (‼️ **전역에서 유일**해야 하고 반드시 `bot`으로 끝남 — 이미
     있으면 `mantle_kr_herald2_bot` 처럼 뒤에 숫자를 붙이세요)
2. BotFather가 주는 토큰(`123456789:ABCdef...`)을 `.env`에:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   ```
   > ⚠️ 봇 토큰은 비밀입니다 — 절대 커밋·공유 금지(`.env`는 git-ignored).

### T-2. 봇을 대상 채널/그룹에 추가

봇은 **자기가 들어가 있는** 채팅에만 발행할 수 있고, 사람이 먼저 추가해야 합니다(자동 참여 없음).
대상이 **그룹**이냐 **채널**이냐에 따라 조금 다릅니다(우리 팀 대상이 그룹이면 아래 "그룹" 쪽):

- **그룹(또는 슈퍼그룹):** 봇을 그룹에 **멤버로 추가**하면 발송됩니다 — 관리자가 아니어도 됩니다
  (그룹이 "관리자만 발송"으로 잠겨 있지 않은 한).
- **채널(브로드캐스트):** 봇을 **관리자(Administrators) 추가** → **"메시지 게시(Post messages)" 권한**을
  켜야 발송됩니다.
- **처음엔 테스트 채팅** 권장 — 이름 예: **`Mantle KR Herald — 발송 테스트`**. 검증이 끝나면 실제 대상으로
  바꾸면 됩니다(그 방의 `TELEGRAM_CHAT_ID_*` 값만 교체).

### T-3. 방마다 `chat_id` 확인 → `TELEGRAM_CHAT_ID_*`

발송 단위는 **채널이 아니라 방(room)** 입니다. 텔레그램 자동 발송 방은 두 곳이고, 각자 자기 환경변수를
가집니다(봇을 **두 방 모두**에 넣어야 합니다):

| 방                  | 환경변수                     | 기본 대상 타입          |
| ------------------- | ---------------------------- | ----------------------- |
| 맨틀 한국 커뮤니티  | `TELEGRAM_CHAT_ID_COMMUNITY` | 공지(announcement) · 소통(casual) |
| 맨틀 한국 데브방    | `TELEGRAM_CHAT_ID_DEV`       | 공지(announcement) · 해설(explainer) |

숫자 id가 필요합니다(그룹은 음수 `-123456789`, **슈퍼그룹·채널은 `-100`으로 시작**).

1. 봇을 대상 방에 넣은 뒤, **그 방에서** 메시지를 하나 보냅니다.
   - **그룹은 봇이 privacy mode**라 일반 메시지가 봇에 안 보일 수 있으니, **봇을 멘션
     (`@mantle_kr_herald_bot …`)** 하거나 슬래시 명령을 그룹에 한 번 보내세요(또는 봇을 그룹 관리자로 잠깐
     올리면 전부 보입니다).
2. 브라우저에서 열기:
   ```
   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
   ```
   응답에서 chat id를 확인합니다 — **그룹은 `message.chat.id`**, **채널은 `channel_post.chat.id`**
   (예: `-1001234567890`).
   - **방마다 반복하세요.** 커뮤니티방에서 한 번, 데브방에서 한 번 메시지를 보내고 `getUpdates`를 다시
     열면 방마다 다른 chat id가 보입니다 — 어느 id가 어느 방인지는 같은 응답의 `chat.title`로 확인합니다.
   - 안 보이면: 그 채팅의 메시지를 **@userinfobot**(또는 @getidsbot)으로 **전달(forward)** 하면 id를 알려줍니다.
3. `.env`에:
   ```bash
   TELEGRAM_CHAT_ID_COMMUNITY=-1001234567890
   TELEGRAM_CHAT_ID_DEV=-1009876543210
   ```

**비워두면 그 방으로는 발송하지 않습니다.** 준비된 방부터 먼저 열어도 됩니다 — 값이 없는 방은 `sent`에도
`failed`에도 들어가지 않고, 요약 줄 끝에 `· 미설정 1 (TELEGRAM_CHAT_ID_DEV)`로 따로 표시됩니다(=
"보낼 곳이 아직 설정되지 않았다", 고장이 아닙니다).

**`TELEGRAM_CHAT_ID`(옛 변수, 지금은 읽지 않습니다).** 방이 하나뿐이던 시절의 단일 변수입니다. 방별
변수로 나뉜 뒤 한동안 커뮤니티방 폴백으로 남아 있었지만 **지금은 완전히 제거됐습니다** — `.env`에 남아
있어도 무시됩니다. 예전 `.env`를 쓰고 있다면 그 값을 `TELEGRAM_CHAT_ID_COMMUNITY`로 옮기고 옛 줄은
지우세요. 폴백을 없앤 이유는 그것이 **한 방(커뮤니티)만** 가리켰기 때문입니다 — 절반만 옮긴 `.env`에서
데브방 문구가 조용히 커뮤니티방으로 나갈 수 있었고, 발송은 되돌릴 수 없습니다.

**방을 나중에 추가할 때.** `renderings.json`은 지워지지 않고 승인 상태도 그대로라, 새로 설정한 방에는
**그동안 승인된 렌더링 전부**가 미발송으로 남아 있습니다. 그대로 두면 첫 실행에서 그 백로그가 한꺼번에
실제 방으로 나가므로, 한 번도 발송한 적 없는 방에 2건 이상이 대기 중이면 **보류하고 경고만 남깁니다**
(방 이름 + 건수). 확인한 뒤 방을 명시해야 실제로 나갑니다:

```bash
pnpm send:channels --target telegram --outlets tg-dev
```

### T-4. 검증

```bash
pnpm send:channels --target telegram                    # 설정된 모든 방
pnpm send:channels --target telegram --outlets tg-dev   # 특정 방만
```

승인된 `telegram` 렌더링이 각 방에 뜨면 성공. (보낼 게 없으면 `sent 0` — §"보낼 게 없을 때" 참고.)

---

## Typefully (X 발행)

X 공식 API/twitterapi.io 쓰기 대신 **Typefully**로 X에 올립니다(공식 계정 정지 리스크 회피). **API는 무료
플랜에 포함**됩니다(월 15건·소셜셋 1개; 넘으면 Pro $10/월 = 월 1,000건).

### Y-1. 계정 + X 계정 연결

1. **typefully.com** 가입(무료 플랜으로 충분).
2. 발행할 **X 계정을 Typefully에 연결**.
   > ⚠️ Typefully로 발행하면 **연결된 그 X 계정에 실제로** 올라갑니다 — 처음엔 **테스트 X 계정**을 연결하세요.

### Y-2. v2 API 키 → `TYPEFULLY_API_KEY`

- typefully.com → **Settings → API** → **v2** 키 발급(‼️ v1 키는 v2 API에서 안 됩니다).
- 키 **이름/레이블**을 물으면 **`mantle-kr-herald-send`** 로 지정하세요(나중에 어떤 앱이 쓰는 키인지 알아보기 쉽게). 이름 칸이 없으면 넘어가세요.
  ```bash
  TYPEFULLY_API_KEY=...
  ```

### Y-3. `social_set_id` → `TYPEFULLY_SOCIAL_SET_ID`

소셜셋(연결된 계정 묶음) id를 조회합니다. Y-2에서 발급한 키를 셸 변수에 넣고 조회하세요(두 줄을
**한 번에** 실행 — 셸 변수는 명령마다 초기화됩니다). 프롬프트에서 `! ` 로 실행하면 출력이 이 세션에 들어옵니다:

```bash
TYPEFULLY_API_KEY='여기에_Y-2_v2_키_붙여넣기'
curl -s https://api.typefully.com/v2/social-sets -H "Authorization: Bearer $TYPEFULLY_API_KEY"
```

응답에서 그 X 계정이 연결된 셋의 `id`를 `.env`에:

```bash
TYPEFULLY_SOCIAL_SET_ID=42
```

### Y-4. 검증

```bash
pnpm send:channels --target x
```

승인된 `x` 렌더링이 Typefully를 통해 그 X 계정에 발행되고 트윗 URL이 기록되면 성공.

### Y-5. 월간 발행 쿼터

X 발행을 실제로 막는 건 API 레이트 리밋이 아니라 소셜셋의 **월간 발행 쿼터**입니다. 레이트 리밋은
리소스별·계정 단위로 시간마다 초기화되고(`/v2/me` 5000/시간, drafts 2500/시간, 소셜셋 500/시간)
우리 물량으로는 절대 닿지 않습니다 — 실제 한도는 요금제가 정한 월간 발행 건수입니다. 지금 쓰는
요금제는 월 15건이 한도이고, 매월 1일(KST)에 초기화됩니다.

남은 건수는 `pnpm doctor --live`와 대시보드 2차 검수(발송판) 배너에서 각각 확인할 수 있습니다:

```
✓ Typefully  live  publishing quota 6 left of 15 · resets 2026-08-01
```

대시보드에는 같은 정보가 배너로 뜹니다(`X 발행 잔여 6건 / 15건 · 08/01 리셋`) — 남은 건수가 3건
이하로 떨어지면 배너가 amber로 바뀌고, 쿼터를 읽지 못하면(오류 등) 배너 자체가 뜨지 않습니다(0건으로
잘못 표시되는 일은 없습니다).

이번 배치가 필요로 하는 건수가 남은 쿼터보다 많으면 X 발송은 **한 건도 나가지 않고 전량 보류**됩니다
— 되는 데까지만 일부 보내는 일은 없습니다. 같은 실행의 텔레그램 발송에는 영향이 없습니다. 보류되면
아무것도 게시되지 않은 것이므로, 리셋 이후 그대로 다시 실행하면 나갑니다.

**단, 화면에 보이는 숫자와 실제 여유는 다를 수 있습니다.** `pnpm doctor --live`와 배너 모두 계정에
남은 발행 건수를 그대로 보여줄 뿐이라, 몇 분 전에 예약(스케줄)됐지만 아직 게시로 확인되지 않은
발송은 그 숫자에서 아직 빠지지 않은 상태입니다. `pnpm send:channels`의 발송 게이트는 이런 예약 건도
내부적으로 차감해서 판단하므로 **그 경로로는** 쿼터를 넘겨 보내는 사고가 나지 않지만, 화면 숫자만
보고 "잔여 N건이니 N건을 더 보낼 수 있다"고 판단하면 안 됩니다 — 직전에 다른 실행이 예약을 넣었다면
실제 여유는 그보다 적습니다.

**`pnpm send:x-article`는 이 게이트를 타지 않습니다.** 아티클이 예약되는 곳은 `SendChannels`가 보는
발송 원장(`deliveries.json`)이 아니라 별도의 `x-article.json`이라, 방금 그 명령으로 예약한 아티클은
게이트의 `used`·`remaining`·예약분 계산 어디에도 잡히지 않습니다. `send:x-article`을 막 돌린 직후
같은 계정으로 다른 X 배치(`send:channels --target x`)를 시작한다면, 화면 숫자를 그대로 믿지 말고
`pnpm doctor --live`로 실제 잔여를 먼저 확인하세요.

---

## 함께 검증 / 참고

```bash
pnpm send:channels                     # 기본: 모든 채널
pnpm send:channels --target both       # telegram + x
pnpm send:channels --target telegram   # 텔레그램만
pnpm send:channels --ids x:123,x:456   # 특정 아이템만
pnpm send:channels --outlets tg-dev    # 특정 방만
```

- **멱등(중복 발송 방지):** `output/publish/deliveries.json`이 `(아이템:타입:방)`별 발송 이력을 기록 —
  재실행은 **이미 보낸 건 건너뛰고**, 실패한 건만 다시 시도합니다. 한 채널에 방이 둘이면 **방마다 한 행**이
  남으므로, 커뮤니티방에 보냈다고 데브방이 보낸 것으로 처리되지 않습니다. 발송 성공 후 기록에 실패하면 그
  아이템은 `sent`로 세되 "기록 실패, 수동 확인 필요" 경고가 뜹니다.
  - 예전 원장 `output/publish/channels.json`이 남아 있으면 **읽기 전용으로 자동 이관**됩니다(채널 → 그
    채널의 대표 방: `telegram` → 맨틀 한국 커뮤니티). 원본 파일은 고치지도 지우지도 않으므로 되돌려도
    잃는 게 없습니다.
- **어느 모드에서도 동작.** `cloud` + `GSHEET_ID`가 있으면 Google Sheet `history` 탭에도 best-effort로
  기록돼 §9b 노출수 집계로 이어집니다(없어도 발송은 정상).

## 보낼 게 없을 때 (`sent 0`)

`send:channels`는 **`status: "approved"`인 `telegram`/`x` 렌더링만** 보냅니다. `sent 0`이면 보낼 승인
렌더링이 없는 것 — 대시보드(`pnpm serve`) 2차 검수에서 해당 렌더링을 **승인**하면 다음 실행 때 나갑니다.

## 자주 나는 오류

| 증상                                    | 원인 / 해결                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Telegram `400 chat not found`           | 봇이 그 방에 없거나 그 방의 `TELEGRAM_CHAT_ID_*` 오타 → 봇을 그 방에 추가, id 재확인 |
| 요약 줄에 `미설정 1 (TELEGRAM_CHAT_ID_DEV)` | 그 방의 chat id가 비어 있음(고장 아님) → 쓸 방이면 T-3으로 값 채우기 |
| 요약 줄에 `보류 N (첫 발송 …)`          | 한 번도 발송한 적 없는 방에 백로그가 쌓여 있음 → 내용 확인 후 `--outlets <방 id>`로 실행 |
| Telegram `403 ... not enough rights`    | (채널) "메시지 게시" 권한 없음 → 관리자 설정에서 켜기 / (그룹) "관리자만 발송"이면 봇을 관리자로 |
| Typefully `401`                         | API 키가 v1이거나 오타 → Settings → API에서 **v2** 키                         |
| `social_set_id`를 모름                  | `GET /v2/social-sets`로 목록 조회(Y-3)                                        |
| 발행했는데 아무 것도 안 나감 (`sent 0`) | 보낼 승인 렌더링 없음 → 2차 검수에서 telegram/x 렌더링을 approved로           |

> **보안:** 봇 토큰·API 키·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만 사용합니다.
