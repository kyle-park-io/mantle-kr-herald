import type { ConversionType } from "../domain/conversion/models";

export interface ConversionConfig {
  loadTypeGuide(type: ConversionType): Promise<{ text: string }>;
}
