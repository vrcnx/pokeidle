import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  const [match, setMatch] = useState<boolean>(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatch(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return match;
}
