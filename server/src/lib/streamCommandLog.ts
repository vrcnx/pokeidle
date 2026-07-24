// Ephemeral per-user log of stream-command OUTCOMES.
//
// The admin's POST only knows whether the command was *delivered* (the account
// has a live socket). It could not know whether the stream client actually ran
// it — so a command the client rejected ("that town isn't unlocked", "need all
// gym badges first") still reported a cheerful "Sent", which read as "the
// button does nothing". The stream client now echoes its result back over the
// socket and we keep the last few here for the dashboard to show.
export interface CommandResult {
  kind: string;
  ok: boolean;
  message: string;
  at: number;
}

const MAX_PER_USER = 8;
const TTL_MS = 5 * 60_000;
const log = new Map<string, CommandResult[]>();

export function recordCommandResult(userId: string, r: Omit<CommandResult, "at">): void {
  const entry: CommandResult = { ...r, at: Date.now() };
  const list = log.get(userId) ?? [];
  list.push(entry);
  while (list.length > MAX_PER_USER) list.shift();
  log.set(userId, list);
}

export function getCommandResults(userId: string): CommandResult[] {
  const now = Date.now();
  const list = (log.get(userId) ?? []).filter((r) => now - r.at <= TTL_MS);
  if (list.length === 0) log.delete(userId);
  else log.set(userId, list);
  return list;
}
