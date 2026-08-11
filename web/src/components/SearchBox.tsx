/**
 * 1차와 2차 사이드바가 공유하는 검색 입력 한 줄. 상태는 갖지 않는다 — 어느 목록이 무엇으로
 * 좁혀졌는지는 그 목록의 일이다.
 *
 * 테두리·라운드·`focus:border-mint`는 `RenderingList.tsx`의 `selectClass`와 같은 값이다. 2차
 * 헤더에서 이 입력은 채널·타입 셀렉트 바로 아래 줄에 서므로, 둘의 테두리가 다르면 눈에 띈다.
 * 그 문자열을 import 하지는 않는다 — 공용 컴포넌트가 2차 전용 파일에 의존하게 된다.
 *
 * `type="search"`가 아니라 `type="text"`인 것은 의도다. WebKit이 search 입력에 자기 지우기
 * 버튼을 그려서, 아래 × 옆에 하나가 더 생긴다.
 */
export function SearchBox(props: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onChange("");
        }}
        placeholder="본문 · ID 검색"
        // 초성 힌트는 placeholder에 넣지 않는다 — `w-80` 사이드바에서 잘리고, 잘린 힌트는 힌트가
        // 아니다. 여기서는 잘리지 않는다.
        title="초성으로도 찾습니다 — ㅁㅌ 로 맨틀. 치는 도중(맨ㅌ, 맨트)에도 걸립니다."
        aria-label="검색"
        className="w-full rounded-lg border border-line bg-surface py-1 pl-2 pr-7 text-[13px] text-ink outline-none placeholder:text-faint focus:border-mint"
      />
      {props.value !== "" && (
        <button
          type="button"
          onClick={() => props.onChange("")}
          aria-label="검색어 지우기"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[15px] leading-none text-faint transition-colors hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
