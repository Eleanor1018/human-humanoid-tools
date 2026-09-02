import { useCallback } from "react";

import type { WorkspaceLocale } from "@/runtime/types";

export type LocaleText = (english: string, chinese: string) => string;

/** Stable bilingual copy selector shared by all workbench contributions. */
export function useLocaleText(locale: WorkspaceLocale): LocaleText {
  return useCallback(
    (english: string, chinese: string) =>
      locale === "zh-CN" ? chinese : english,
    [locale],
  );
}
