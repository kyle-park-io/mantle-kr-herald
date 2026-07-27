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

1. Telegram에서 **@BotFather** 검색 → `/newbot` → 표시 이름과 username(`..._bot`) 지정
2. BotFather가 주는 토큰(`123456789:ABCdef...`)을 `.env`에:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   ```
   > ⚠️ 봇 토큰은 비밀입니다 — 절대 커밋·공유 금지(`.env`는 git-ignored).

### T-2. 봇을 대상 채널에 **관리자**로 추가

봇은 **자기가 들어가 있는** 채널/그룹에만 발행할 수 있고, 사람이 먼저 추가해야 합니다(자동 참여 없음).

- 대상 채널(**처음엔 테스트 채널** 권장) → **관리자(Administrators) 추가** → 봇 선택 →
  **"메시지 게시(Post messages)" 권한 켜기**.

### T-3. `chat_id` 확인 → `TELEGRAM_CHAT_ID`

비공개 채널은 숫자 id가 필요합니다(채널은 `-100`으로 시작).

1. 봇을 채널에 관리자로 넣은 뒤, 채널에 아무 메시지나 하나 게시합니다.
2. 브라우저에서 열기:
   ```
   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
   ```
   응답의 `channel_post.chat.id`(예: `-1001234567890`)가 chat_id입니다.
   - 안 보이면: 채널 메시지를 **@userinfobot**(또는 @getidsbot)으로 **전달(forward)** 하면 id를 알려줍니다.
3. `.env`에:
   ```bash
   TELEGRAM_CHAT_ID=-1001234567890
   ```

### T-4. 검증

```bash
pnpm send:channels --target telegram
```
승인된 `telegram` 렌더링이 그 채널에 뜨면 성공. (보낼 게 없으면 `sent 0` — §"보낼 게 없을 때" 참고.)

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
  ```bash
  TYPEFULLY_API_KEY=...
  ```

### Y-3. `social_set_id` → `TYPEFULLY_SOCIAL_SET_ID`

소셜셋(연결된 계정 묶음) id를 조회합니다. 프롬프트에서 `! ` 로 실행하면 출력이 이 세션에 들어옵니다:
```bash
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

---

## 함께 검증 / 참고

```bash
pnpm send:channels                    # 기본: 모든 채널
pnpm send:channels --target both      # telegram + x
pnpm send:channels --target telegram  # 텔레그램만
pnpm send:channels --ids x:123,x:456  # 특정 아이템만
```

- **멱등(중복 발송 방지):** `output/publish/channels.json`이 `(아이템:타입:채널)`별 발송 이력을 기록 —
  재실행은 **이미 보낸 건 건너뛰고**, 실패한 건만 다시 시도합니다. 발송 성공 후 기록에 실패하면 그 아이템은
  `sent`로 세되 "기록 실패, 수동 확인 필요" 경고가 뜹니다.
- **어느 모드에서도 동작.** `cloud` + `GSHEET_ID`가 있으면 Google Sheet `history` 탭에도 best-effort로
  기록돼 §9b 노출수 집계로 이어집니다(없어도 발송은 정상).

## 보낼 게 없을 때 (`sent 0`)

`send:channels`는 **`status: "approved"`인 `telegram`/`x` 렌더링만** 보냅니다. `sent 0`이면 보낼 승인
렌더링이 없는 것 — 대시보드(`pnpm serve`) 2차 검수에서 해당 렌더링을 **승인**하면 다음 실행 때 나갑니다.

## 자주 나는 오류

| 증상                                            | 원인 / 해결                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Telegram `400 chat not found`                   | 봇이 그 채널에 없거나 `TELEGRAM_CHAT_ID` 오타 → 봇을 관리자로 추가, id 재확인 |
| Telegram `403 ... not enough rights`            | 봇에 "메시지 게시" 권한 없음 → 채널 관리자 설정에서 켜기                    |
| Typefully `401`                                 | API 키가 v1이거나 오타 → Settings → API에서 **v2** 키                      |
| `social_set_id`를 모름                          | `GET /v2/social-sets`로 목록 조회(Y-3)                                     |
| 발행했는데 아무 것도 안 나감 (`sent 0`)          | 보낼 승인 렌더링 없음 → 2차 검수에서 telegram/x 렌더링을 approved로        |

> **보안:** 봇 토큰·API 키·`.env`는 절대 공유·커밋하지 마세요. 각자 로컬에서만 사용합니다.
