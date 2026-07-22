import { useEffect, useState } from "react";
import { api, type PublicPoll } from "../net/api";
import { getSocket } from "../net/socket";
import { useT } from "../i18n/useT";

// Renders inline inside a "pollOpen" system chat card — the whole point
// of a chat poll is voting without leaving the conversation, so this
// isn't a "click here to open a modal" link like the giveaway card's
// action button; it's the actual interactive widget.
export function PollCard({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<PublicPoll | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    api.getPoll(pollId)
      .then((res) => { if (!cancelled) setPoll(res.poll); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [pollId]);

  // Live tallies as OTHER players vote — same broadcast pattern as the
  // auction board's live bid ticks.
  useEffect(() => {
    const sock = getSocket();
    const onVoted = (payload: { pollId: string; tallies: number[]; totalVotes: number }) => {
      if (payload.pollId !== pollId) return;
      setPoll((p) => (p ? { ...p, tallies: payload.tallies, totalVotes: payload.totalVotes } : p));
    };
    sock.on("poll:voted", onVoted);
    return () => { sock.off("poll:voted", onVoted); };
  }, [pollId]);

  if (err) return <div className="poll-card poll-card-error dim small">{err}</div>;
  if (!poll) return <div className="poll-card dim small">{t("Loading…")}</div>;

  const vote = (optionIndex: number) => {
    if (poll.status !== "open" || voting) return;
    setVoting(true);
    const previousVote = poll.myVote;
    // Optimistic: bump the local tally immediately so the click feels
    // instant; the server response (and the broadcast every OTHER
    // viewer gets) reconciles the real count right after.
    setPoll((p) => {
      if (!p) return p;
      const tallies = [...p.tallies];
      if (previousVote !== null && previousVote !== optionIndex) tallies[previousVote] = Math.max(0, tallies[previousVote] - 1);
      if (previousVote !== optionIndex) tallies[optionIndex] += 1;
      return { ...p, tallies, myVote: optionIndex, totalVotes: previousVote === null ? p.totalVotes + 1 : p.totalVotes };
    });
    api.votePoll(pollId, optionIndex)
      .then((res) => setPoll((p) => (p ? { ...p, tallies: res.tallies, totalVotes: res.totalVotes, myVote: res.myVote } : p)))
      .catch((e) => {
        setErr(e.message);
        // Roll back the optimistic update on failure.
        api.getPoll(pollId).then((res) => setPoll(res.poll)).catch(() => undefined);
      })
      .finally(() => setVoting(false));
  };

  const closed = poll.status !== "open";

  return (
    <div className="poll-card">
      <strong className="poll-card-question">{poll.question}</strong>
      <div className="poll-card-options">
        {poll.options.map((opt, i) => {
          const count = poll.tallies[i] ?? 0;
          const pct = poll.totalVotes > 0 ? Math.round((count / poll.totalVotes) * 100) : 0;
          const mine = poll.myVote === i;
          return (
            <button
              key={i}
              type="button"
              className={`poll-card-option ${mine ? "mine" : ""} ${closed ? "closed" : ""}`}
              disabled={closed || voting}
              onClick={() => vote(i)}
            >
              <span className="poll-card-option-fill" style={{ width: `${pct}%` }} />
              <span className="poll-card-option-label">{mine && "✓ "}{opt}</span>
              <span className="poll-card-option-pct">{pct}%</span>
            </button>
          );
        })}
      </div>
      <div className="poll-card-foot dim small">
        {poll.totalVotes} {poll.totalVotes === 1 ? t("vote") : t("votes")}
        {closed && ` · ${t("Poll closed")}`}
      </div>
    </div>
  );
}
