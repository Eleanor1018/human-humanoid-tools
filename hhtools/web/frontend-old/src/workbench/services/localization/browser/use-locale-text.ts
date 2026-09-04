import { useCallback } from "react";

import type { WorkspaceLocale } from "@/workbench/common/workspace";

export type LocaleText = (english: string, chinese: string) => string;

/** React adapter over the browser-independent Workbench locale identity. */
export function useLocaleText(locale: WorkspaceLocale): LocaleText {
  return useCallback(
    (english: string, chinese: string) =>
      locale === "zh-CN" ? chinese : english,
    [locale],
  );
}
