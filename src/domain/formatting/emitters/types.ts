/**
 * Where a rendering actually ends up. A channel can have more than one: the same Telegram post
 * is spelled differently depending on whether a human pastes it into the app or a bot sends it
 * through the API.
 */
export type Destination =
  | "x_paste"
  | "x_typefully"
  | "telegram_paste"
  | "telegram_bot"
  | "kakao_paste"
  | "pr_mail";

export interface EmitSegment {
  text: string;
  /** Position label, e.g. "트윗 2/3". Absent when there is only one segment. */
  label?: string;
  /** Weighted units for x, characters for telegram/kakao, worst line in octets for pr_mail. */
  length: number;
  limit: number;
  overLimit: boolean;
}

export interface EmitResult {
  segments: EmitSegment[];
  warnings: string[];
}
