import type { CorpusStatus, GlossaryCandidate, MiningResult, RejectedCandidate } from "./glossaryMining";

/**
 * The file `glossary:mine` leaves for a human — the one artifact of the whole job.
 *
 * JSON, not the Markdown `renderPairsReview` (src/domain/tm/pairsReview.ts) produces, and the shape
 * is not a design choice made here: it reproduces the file a human actually filled in and applied on
 * 2026-08-11 (`output/glossary-draft.json`, ten entries, all ten accepted). The workflow that file
 * supports is "delete the lines you don't want, edit the ones you do, then `pnpm glossary add`", and
 * every field below is either a `glossary add` flag or an underscore-prefixed note explaining itself.
 *
 * Underscore keys are deliberately not a nested `_meta` object. They have to survive a human deleting
 * lines around them in a text editor, and a nested block turns "delete this entry" into "delete this
 * entry and remember to fix the comma".
 *
 * Pure: the caller passes the paths and the date, so this reads no clock and touches no disk.
 */

/** A one-line divider a human's eye can find while scrolling a long array. */
const section = (title: string): Record<string, string> => ({ _구간: `──────── ${title} ────────` });

/** What the corpus contributed, in one sentence, for the header block. */
export function corpusSummary(corpus: CorpusStatus): string {
  switch (corpus.state) {
    case "missing":
      return (
        "참조 코퍼스(output/x/reference/items.json)가 없습니다 — 대조 없이 뽑은 후보라 전부 B입니다. " +
        "`pnpm collect:reference`를 한 번 돌리시면 다음 주부터 등급이 살아납니다."
      );
    case "undated":
      return (
        `참조 코퍼스 ${corpus.tweetCount}트윗으로 대조했지만 수집 기간(runs.json)을 못 읽어 ` +
        "언제까지의 데이터인지 모릅니다 — 안전하게 전부 B로 낮췄습니다. " +
        "`pnpm collect:reference`를 한 번 돌리시면 원장이 다시 생깁니다."
      );
    case "stale":
      return (
        `참조 코퍼스 ${corpus.tweetCount}트윗 · ${corpus.coveredFrom.slice(0, 10)}~${corpus.coveredTo.slice(0, 10)} — ` +
        `최신 글이 ${corpus.ageDays}일 지났습니다. 그동안 계정이 새로 쓰기 시작한 표현은 0회로 잡히므로 ` +
        "전부 B로 낮췄습니다. `pnpm collect:reference`로 갱신하세요."
      );
    case "fresh":
      return (
        `참조 코퍼스 ${corpus.tweetCount}트윗 · ${corpus.coveredFrom.slice(0, 10)}~${corpus.coveredTo.slice(0, 10)} ` +
        `(${corpus.ageDays}일 전까지)로 대조했습니다.`
      );
  }
}

function candidateEntry(c: GlossaryCandidate): Record<string, unknown> {
  const entry: Record<string, unknown> = { term: c.term };
  if (c.signal === "substitution") {
    // The two fields a human needs to turn this into a real entry: what changed, and what the source
    // called the thing. `term` above is the human's own Korean — correct as a `target`, wrong as a
    // `term`, which must match the ENGLISH source (`checkGlossary` matches against `sourceText`).
    entry._초안_발행 = `${c.draft} → ${c.published}`;
    entry._원문_후보 = c.sourceTerms ?? [];
  }
  if (c.rule) entry.rule = c.rule;
  if (c.target) entry.target = c.target;
  entry.note = c.note;
  entry.source = c.source;
  entry._후보 = c.key; // the exact string glossary-dismissed.json wants, so silencing is a copy-paste
  return entry;
}

function rejectedEntry(r: RejectedCandidate): Record<string, unknown> {
  return { _기각: r.key, _근거: r.reason, _항목: r.itemIds };
}

export interface ReviewFileOptions {
  /** Absolute path this file is being written to — repeated inside it, so a copy that got moved still says where it came from. */
  path: string;
  /** ISO instant of the run. */
  now: string;
  /** How many source tweets and translation pairs the candidates were mined from. */
  sourceTweetCount: number;
  translationCount: number;
}

/**
 * What the positional rule removed, as one sentence in the header — a count, never a list.
 *
 * Silence here would be the wrong kind of quiet. The filter is the difference between 170 lines and
 * 90, and a reader who does not know a term was dropped has no way to ask why it is missing. Omitted
 * entirely when it removed nothing, so an ordinary week does not carry a "0건" nobody needs.
 */
const positionalNote = (dropped: number): string =>
  dropped === 0
    ? ""
    : ` 줄·문장 첫머리에만 나오는 대문자 낱말 ${dropped}개는 후보에서 뺐습니다(문장 중간에 한 번도 ` +
      `안 나오면 고유명사로 볼 근거가 없습니다 — 계정이 그 말을 문장 안에 쓰기 시작하면 다시 올라옵니다).`;

export function renderCandidateReview(result: MiningResult, opts: ReviewFileOptions): unknown[] {
  const { candidates, rejected, corpus } = result;
  const a = candidates.filter((c) => c.tier === "A");
  const b = candidates.filter((c) => c.tier === "B");

  const out: unknown[] = [
    {
      _사용법:
        "적용할 것만 남기고 나머지 줄은 지우세요. rule/target/note 자유롭게 고치셔도 됩니다. " +
        "다 되면 `pnpm glossary add --term … --rule … [--target …] --note … --source …`로 넣으시면 됩니다.",
      _term_주의:
        "term은 반드시 **원문(영어) 표기**여야 합니다 — 용어집 검사는 원문 텍스트에 대고 매칭합니다. " +
        "치환 후보의 term에는 사람이 고쳐 쓴 한국어가 들어 있으니, `_원문_후보`를 보고 영어 쪽으로 바꿔 주세요.",
      _근거:
        `수집된 원문 ${opts.sourceTweetCount}트윗과 발행본이 있는 번역 ${opts.translationCount}건에서 ` +
        `뽑았습니다. ${corpusSummary(corpus)}${positionalNote(result.sentenceInitialOnly)}`,
      _신뢰도: "A = 코퍼스 증거 압도적 · B = 표본이 작거나, 코퍼스가 혼용이거나, 표기를 사람이 채워야 함",
      _이건_아니다_싶으면:
        'translation/glossary-dismissed.json에 {"term": "<아래 _후보 값>", "note": "왜", "dismissedAt": "YYYY-MM-DD"}를 ' +
        "추가하세요. 다음 주부터 이 후보는 안 올라옵니다 — 안 그러면 매주 같은 줄이 다시 옵니다.",
      _생성: `${opts.now} · ${opts.path}`,
    },
  ];

  if (candidates.length === 0) {
    out.push(section("이번 주 결정할 후보 없음"));
  }
  if (a.length > 0) {
    out.push(section(`A. 증거 압도적 (${a.length}건)`));
    out.push(...a.map(candidateEntry));
  }
  if (b.length > 0) {
    out.push(section(`B. 증거 있으나 표본이 작거나 채워야 함 (${b.length}건)`));
    out.push(...b.map(candidateEntry));
  }
  if (rejected.length > 0) {
    // Listed, never dropped. These are the ones the corpus argued AGAINST, and the run that produced
    // this format threw away two entries here that would otherwise have entered the glossary as wrong
    // renderings (시장가, 사이즈). Showing the work is what lets a human overrule it.
    out.push(section(`검토됨 · 기각 — 코퍼스가 우리 초안 편이었습니다 (${rejected.length}건)`));
    out.push(...rejected.map(rejectedEntry));
  }
  return out;
}
