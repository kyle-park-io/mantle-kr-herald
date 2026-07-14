# 드라이브 셋업 가이드 (서브시스템 D) — 인덱스

`pnpm drive:publish`가 번역 결과를 두 드라이브에 올리려면 `.env`에 자격증명·폴더 값을 채워야 합니다.
플랫폼별 상세 가이드를 참고하세요:

- **[Google Drive 셋업 가이드](./google-drive-setup-guide.md)** — 서비스 계정·JSON 키·폴더 ID
  (`GOOGLE_SA_KEY_FILE`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`)
- **[Lark Drive 셋업 가이드](./lark-drive-setup-guide.md)** — Drive 스코프·폴더 token
  (`LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN`; 앱 자격증명은 B에서 재사용)

> Lark **앱 자체**(App ID/Secret) 만들기는 [lark-setup-guide.md](./lark-setup-guide.md) 참고.

## 실행

```bash
pnpm drive:publish                 # 둘 다
pnpm drive:publish --target google # 구글만
pnpm drive:publish --target lark   # Lark만
```

`output/publish-state.json`이 (아이템:상태:드라이브)별로 업로드 이력을 기록해 중복 업로드를 막습니다.
검증은 각 플랫폼 가이드의 "검증" 절 참고 (`pnpm test tests/adapters/drive/drive.probe.test.ts`로 실업로드 probe).
