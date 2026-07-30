# `kol-map` 시딩 제안 (kol-map-seed.md)

**이 문서는 제안(proposal)입니다. 워크북에는 아무것도 쓰지 않았습니다.** 아래 표는
`2026 Q3 KR Work Sheet`를 읽기 전용으로 조회해 만들었을 뿐이고, `kol-map` 탭 자체도 아직
만들어지지 않았습니다(2026-07-30 기준 확인). 사람이 각 KOL의 **실제 계약서**와 가격을 대조해
확인한 뒤, 새 `kol-map` 탭을 만들어 아래 표를 직접 붙여넣어야 합니다. 에이전트가 이 표를 승인하거나
시트에 쓰는 일은 없습니다.

## 출처

` Q3 KOL 계약 리스트` 탭의 `Q3 조정 단가 표` 블록 — 헤더가 **29행**, 데이터가 **30–42행**(13개
t.me 링크)입니다. 스펙(`2026-07-30-kol-telegram-deliverable-sync-design.md`)이 기록한 위치와
동일해, 이 문서 작성 시점까지 범위가 이동하지 않았습니다. `pricePerPost`는 이 블록의 `Q3 조정
개당 단가` 컬럼(C열)에서 **서식이 반올림하지 않은 원본 숫자**(`UNFORMATTED_VALUE`)로 읽었습니다 —
시트가 화면에 보여주는 통화 서식(`$63` 등)은 정수로 반올림되어 있어 그대로 옮기면 값이 달라집니다.

## 제안 표

| kolId | tgHandle | sheetLabel | pricePerPost | active |
|---|---|---|---|---|
| enjoyhobby | enjoymyhobby | Enjoyhobby | 62.5 | |
| gmb | GMBLABS | *(월별 탭에 행 없음 — 아래 참고)* | 75 | |
| raoni | Raoni1 | Raoni | 60 | |
| cek | airdr0p_lab | CEK | 60 | |
| marine | marshallog | Marine | 100 | |
| murphy | murphybus | *(월별 탭에 행 없음 — 아래 참고)* | 200 | |
| leedogin | leedogin2 | *(월별 탭에 행 없음 — 아래 참고)* | 91.6667 | |
| coinboy | coinboys | Coinboy | 100 | |
| airdrop_atm | Bounty_ATM | *(월별 탭에 행 없음 — 아래 참고)* | 100 | |
| maesil | waitstudy | Maesil | 150 | |
| wecrypto | WeCryptoTogether | Wecrypto | 600 | |
| bq | BQTelegram | *(월별 탭에 행 없음 — 아래 참고)* | 130 | |
| chungchun | CRYPTOSCH00L | *(월별 탭에 행 없음 — 아래 참고)* | 100 | |

`kol-map` 탭의 헤더 행(1행)은 그대로 `kolId | tgHandle | sheetLabel | pricePerPost | active`
다섯 컬럼이어야 합니다.

위 표의 `tgHandle`은 **핸들만 적은 형태**인데 그대로 붙여넣으면 됩니다 —
`https://t.me/<핸들>`·`t.me/<핸들>`·`@<핸들>`·`<핸들>` 네 형태를 모두 읽고, 대소문자도 구분하지
않습니다(`raoni1`로 적어도 `Raoni1` 채널을 찾습니다). 읽을 수 없는 칸은 몇 번째 행인지와 함께
경고로 남고 그 채널만 스윕에서 빠지므로, 첫 실행 뒤 경고와 요약 줄(`N channel(s) swept`)을
확인하세요.

## 각 컬럼을 채운 방법과 확인할 점

- **`tgHandle`** — `Q3 조정 단가 표`의 링크 컬럼(G열)에서 핸들만 뽑아 앞뒤 공백을 trim했습니다.
  원본에 스트레이 공백이 있던 두 셀도 확인했습니다: CEK 행 링크가 `https://t.me/airdr0p_lab `(뒤
  공백), Marine 행 링크가 ` https://t.me/marshallog`(앞 공백) — 둘 다 trim 후에는 정상 핸들입니다.
- **`pricePerPost`** — 반올림하지 않은 원본 숫자입니다. Enjoyhobby가 대표적인 예로, 시트에 표시된
  값은 `$63`이지만 원본 숫자는 `62.5`입니다(CPI 파생 컬럼이 `62.5` 기준으로 계산되어 있어 확인
  가능). **`63`으로 붙여넣지 마세요.** leedogin은 `12건, $1,100`을 12로 나눈 값이라 순환소수
  (`91.666...`)입니다 — 위 표는 소수점 4자리(`91.6667`)로 반올림했으니, 계약서상 정확한 단가가
  따로 있다면 그 값으로 바꿔서 붙여넣으세요.
- **`sheetLabel`** — 월별 탭(`Jul.`/`Aug.`/`Sep.`)의 요약 블록(2–8행) A열 스펠링과 정확히
  일치해야 그 탭의 `SUMIF`/`COUNTIF` 수식에 조인됩니다. 세 탭 모두 요약 블록에 7개 라벨만
  존재합니다: `Raoni`, `Marine`, `Enjoyhobby`, `Coinboy`, `CEK`, `Wecrypto`, `Maesil`. 위 표는
  그 7개에는 정확히 그 스펠링을 넣었습니다.
  **나머지 6개 KOL(GMB, Murphy, leedogin, Airdrop ATM, BQ, Chungchun)은 세 월별 탭 어디에도
  요약 행이 없습니다** — 즉 아직 확립된 스펠링이 없습니다. 여기서 추측해 넣는 대신 빈칸으로
  남겼습니다: 잘못된 `sheetLabel`은 조인이 조용히 깨지는 원인이 되므로, 이 여섯 곳은 사람이 먼저
  해당 월별 탭에 요약 행(A열 라벨 + 2–8행 수식)을 추가한 뒤 그 스펠링을 그대로 넣어야 합니다.
- **`kolId`** — 이 문서에서 새로 제안하는 값입니다(소문자, 공백 없음, 안정적인 식별자). KOL 이름을
  그대로 소문자화했을 뿐 워크북 어디에도 이런 컬럼이 있던 것은 아니니, 팀이 쓰기 편한 다른 값으로
  바꿔도 무방합니다. 한 번 정하면 이후 실행에서 계속 같은 값을 써야 `kol-telegram-posts` 행이
  같은 KOL로 묶입니다.

## `active`는 왜 전부 비워 뒀는가

**`kol-map`의 `active`가 빈칸(또는 `true`/`y`/`yes`/`1`이 아닌 값)인 행은 전부 비활성으로
취급되어 스윕 대상에서 빠집니다** (`LoadKolMap`이 `active`가 참인 행만 반환). 즉 이 표를 그대로
붙여넣으면 **13개 채널 중 어느 것도 자동으로 훑이지 않습니다.**

`Q3 조정 단가 표`는 계약 리스트보다 넓습니다 — 7월에 실제로 계약된 KOL은 7명뿐인데 단가 표는
13명의 가격을 갖고 있습니다(맨틀을 유기적으로 언급한, 계약에 없는 채널까지 잡아내려는 의도).
어떤 채널을 실제로 스윕할지는 사람이 계약 현황을 보고 결정할 일이라 에이전트가 임의로 켜지
않았습니다. 워크북에 붙여넣은 뒤, 지금 계약 중인 채널의 `active` 칸에 `true`를 적어 넣어 주세요.
