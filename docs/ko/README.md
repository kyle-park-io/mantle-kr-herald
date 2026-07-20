# 한국어 문서

`mantle-kr-herald` 사용자 문서입니다. **여기서 시작해서 자기 역할에 맞는 문서로 가세요.**

## 어떤 문서를 봐야 하나

| 이런 분이라면 | 여기부터 | 터미널 |
|---|---|---|
| 이게 뭐 하는 물건인지 알고 싶다 | [`capabilities.md`](capabilities.md) | 필요 없음 |
| **번역·문구를 검수하고 승인만 하면 된다** | [`review.md`](review.md) | **필요 없음** |
| 내 컴퓨터에 설치해서 돌려보고 싶다 | [`quickstart.md`](quickstart.md) | 필요 |
| 팀 계정으로 매주 운영한다 | [`team-runbook.md`](team-runbook.md) | 필요 |
| **팀 용어집·문체 규칙을 받아야 한다** | [`setup/steering.md`](setup/steering.md) | 필요 |
| 자격 증명(Lark·Google)을 발급해야 한다 | [`setup/`](setup/) | 필요 |
| 어떤 명령이 어떤 파일을 건드리는지 확인해야 한다 | [`artifacts.md`](artifacts.md) | 필요 |

코드에 기여하려면 [`../architecture/`](../architecture/)를 보세요 (영어).

## 문서 지도

```
ko/
  capabilities.md    무엇을 할 수 있는가 — 파이프라인 단계, 하지 않는 것
  review.md          검수 가이드 — 브라우저 화면에서 읽고·고치고·승인하기
  quickstart.md      빠른 시작 — 자격 증명 없이 로컬 모드로 5분 안에
  team-runbook.md    팀 운영 매뉴얼 — 주간 루틴, 클라우드 모드, 사고 대응
  artifacts.md       산출물 지도 — 명령별 입출력 계약, 보존 정책
  setup/             자격 증명 발급 절차 (SSOT — 다른 문서는 여기로 링크만)
    README.md          어떤 가이드를 볼지
    steering.md        스티어링 설정(용어집·문체·변환 규칙) 받기 — git에 없음
    google-drive.md    Google OAuth·서비스 계정·폴더 ID
    lark.md            Lark 앱·스코프·Drive 폴더 token
```

## 규칙

**한국어가 정본입니다.** 영어판([`../en/`](../en/))은 이 문서들의 번역이며, 아직 비어 있습니다.
사실이 바뀌면 한국어를 먼저 고치고 영어가 따라옵니다 — 영어에만 있는 사실은 없어야 합니다.

**설치 절차는 [`setup/`](setup/)에만 있습니다.** 다른 문서는 절차를 다시 설명하지 않고 링크만 겁니다.
그렇게 하지 않으면 같은 절차가 서너 벌로 늘어나고, 콘솔 UI가 한 번 바뀌는 순간 전부 어긋납니다.

문서를 새로 추가할 때의 규칙은 [`../README.md`](../README.md)에 있습니다.
