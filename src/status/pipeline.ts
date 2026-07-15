export interface StatusInput {
  collected: number;
  translations: { status: string }[];
  variants: { status: string }[];
  renderings: { status: string }[];
  published: number;
}

export interface StageCount {
  label: string;
  total: number;
  note?: string;
}

const approved = (items: { status: string }[]) => items.filter((i) => i.status === "approved").length;

export function pipelineStages(input: StatusInput): StageCount[] {
  return [
    { label: "Collected (X + Lark)", total: input.collected },
    { label: "Translated", total: input.translations.length, note: `approved ${approved(input.translations)}` },
    { label: "Converted (variants)", total: input.variants.length, note: `approved ${approved(input.variants)}` },
    { label: "Rendered (channels)", total: input.renderings.length, note: `approved ${approved(input.renderings)}` },
    { label: "Published (drive)", total: input.published },
  ];
}

export function formatStatus(stages: StageCount[]): string {
  const labelW = stages.reduce((w, s) => Math.max(w, s.label.length), 0);
  const numW = stages.reduce((w, s) => Math.max(w, String(s.total).length), 0);
  const lines = stages.map(
    (s) => `  ${s.label.padEnd(labelW)}  ${String(s.total).padStart(numW)}${s.note ? `   (${s.note})` : ""}`,
  );
  return ["Pipeline status", "", ...lines].join("\n");
}
