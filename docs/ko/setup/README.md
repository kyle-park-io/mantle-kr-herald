# 드라이브 셋업 가이드 (서브시스템 D) — 인덱스

`pnpm drive:publish`가 번역 결과를 두 드라이브에 올리려면 `.env`에 자격증명·폴더 값을 채워야 합니다.
플랫폼별 상세 가이드를 참고하세요:

- **[스티어링 설정 받기](./steering.md)** — `translation/`·`conversion/`의 실제 파일. git에 없으므로 팀에서 받아야 합니다. **먼저 읽으세요.**

- **[Google Drive 셋업 가이드](./google-drive.md)** — 서비스 계정·JSON 키·폴더 ID
  (`GOOGLE_SA_KEY_FILE`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`)
- **[Lark 셋업 가이드 §10 (Lark Drive)](./lark.md#10-lark-drive-업로드-서브시스템-d)** —
  Drive 스코프·폴더 token (`LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN`).
  Lark 앱·자격증명은 같은 문서(§0–§9)에서 이미 다룹니다.

## 실행

```bash
pnpm drive:publish                       # 저장 모드의 기본 대상 (local 모드→local, cloud 모드→google)
pnpm drive:publish --target google       # 구글만
pnpm drive:publish --target lark         # Lark만
pnpm drive:publish --target both         # google,lark 별칭
pnpm drive:publish --target local        # 로컬 파일 (output/publish/local/)
pnpm drive:publish --target google,local # 쉼표로 여러 대상
```

`output/publish/state.json`이 (아이템:상태:드라이브)별로 업로드 이력을 기록해 중복 업로드를 막습니다.
검증은 각 플랫폼 가이드의 "검증" 절 참고 (`pnpm test tests/adapters/drive/drive.probe.test.ts`로 실업로드 probe).
