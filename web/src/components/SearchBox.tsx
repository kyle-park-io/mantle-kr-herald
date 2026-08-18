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
          // 조합 중인 Escape는 입력을 비우라는 뜻이 아니라 조합 중인 음절을 취소하라는 뜻이다.
          // 이 컴포넌트가 붙는 매처(`hangulSearch.ts`)는 조합 중간 상태를 1급으로 다루는 것이
          // 전제이므로, IME의 취소를 가로채면 그 전제와 부딪힌다. 오늘날 브라우저는 조합 중
          // keydown을 `key: "Process"`로 주기 때문에 이 가드가 실제로 걸릴 일은 드물지만,
          // 방어적으로 남겨둔다 — 나중에 죽은 코드로 보고 지우지 않도록.
          if (e.key === "Escape" && !e.nativeEvent.isComposing) props.onChange("");
        }}
        placeholder="본문 · ID 검색"
        // 초성 힌트는 placeholder에 넣지 않는다 — `w-80` 사이드바에서 잘리고, 잘린 힌트는 힌트가
        // 아니다. 여기서는 잘리지 않는다.
        title="초성으로도 찾습니다 — ㅁㅌ 로 맨틀. 치는 도중(맨ㅌ, 맨트)에도 걸립니다."
        aria-label="검색"
        // `pr-7`(28px)은 지우기 버튼의 원래 폭(px-1 한 글자, ~20px) 기준. `pointer-coarse:`가 그
        // 버튼을 `min-w-11`(44px)로 키우면 이 여백도 같이 키워야 한다 — 아니면 버튼이 입력 끝에서
        // 타이핑한 글자 위로 겹쳐 앉고, 그 글자를 탭한 손가락은 캐럿을 놓는 게 아니라 검색어를 지운다.
        className="w-full rounded-lg border border-line bg-surface py-1 pl-2 pr-7 pointer-coarse:pr-12 text-[13px] text-ink outline-none placeholder:text-faint focus:border-mint"
      />
      {props.value !== "" && (
        <button
          type="button"
          onClick={() => props.onChange("")}
          aria-label="검색어 지우기"
          // ~20px otherwise (a single glyph with `px-1`) — this sits inside the drawer, the phone's
          // primary list surface, so it needs the same `pointer-coarse:` floor as everything else a
          // finger can reach there. `min-h`/`min-w` (not padding) so the box grows without shifting
          // the × off-center.
          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded px-1 text-[15px] leading-none text-faint transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
