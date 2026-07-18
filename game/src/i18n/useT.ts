import { useEffect, useMemo, useState } from "react";
import { getLanguage, subscribeLanguage, type Language } from "./language";
import { TRANSLATIONS } from "./translations";

function identity(str: string): string {
  return str;
}

// t(str) looks up `str` (the literal English source text) in the active
// language's table; falls back to the English input untouched if there's
// no entry. Memoized on `lang` so components that pass `t` into a hook
// dependency array don't re-run every render — only on an actual
// language change.
export function useT(): (str: string) => string {
  const [lang, setLang] = useState<Language>(() => getLanguage());
  useEffect(() => subscribeLanguage(setLang), []);
  return useMemo(() => {
    if (lang === "en") return identity;
    const table = TRANSLATIONS[lang];
    return table ? (str: string) => table[str] ?? str : identity;
  }, [lang]);
}
