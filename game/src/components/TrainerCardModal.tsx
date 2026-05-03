import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
import { gymLeaders } from "../data/gymLeaders";
import { eliteFour } from "../data/eliteFour";
import { pokemonTable } from "../data/pokemon";
import { api, type PublicProfile } from "../net/api";
import { useModalEnter, CountUp } from "../utils/animate";
import { sendTradeInvite, useTradeState } from "../state/trade";

// Trainer card. Two modes:
//   self    — full card with badges, sign-out, etc. (the one the
//             InventoryRibbon avatar opens). No userId passed.
//   public  — a stranger's profile, fetched by username; shows the
//             same badges-style summary plus a "Trade" button. Opened
//             from chat name clicks via `openPublicTrainerCard(username)`.
//
// `closeTrainerCard()` hides whichever variant is currently up.

interface SelfProps { onClose: () => void; mode?: "self" }
interface PublicProps { onClose?: () => void; mode: "public"; username: string }
type Props = SelfProps | PublicProps;

// --- Imperative open API for the public variant -----------------------------
let _publicUsername: string | null = null;
const _publicListeners = new Set<(u: string | null) => void>();
export function openPublicTrainerCard(username: string) {
  _publicUsername = username;
  _publicListeners.forEach((fn) => fn(username));
}
export function closePublicTrainerCard() {
  _publicUsername = null;
  _publicListeners.forEach((fn) => fn(null));
}
function usePublicTrainerCardUsername(): string | null {
  const [u, setU] = useState<string | null>(_publicUsername);
  useEffect(() => {
    _publicListeners.add(setU);
    return () => { _publicListeners.delete(setU); };
  }, []);
  return u;
}
// Mounted from GameShell.
export function PublicTrainerCardMount() {
  const username = usePublicTrainerCardUsername();
  if (!username) return null;
  return (
    <TrainerCardModal mode="public" username={username} onClose={closePublicTrainerCard} />
  );
}

export function TrainerCardModal(props: Props) {
  if (props.mode === "public") return <PublicCard {...props} />;
  return <SelfCard onClose={props.onClose} />;
}

// --- Self card -------------------------------------------------------------

function SelfCard({ onClose }: { onClose: () => void }) {
  const { state } = useGame();
  const { me } = useAuth();
  const totalGyms = gymLeaders.length;
  const totalE4 = eliteFour.length;
  const totalDex = Object.keys(pokemonTable).length;
  const initial = (me?.name ?? me?.username ?? "?")[0]?.toUpperCase() ?? "?";
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal trainer-card-modal-v2"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Trainer Card"
      >
        {/* SVG filter referenced by .g-badge-disc img — adds a 1px
            black stroke INSIDE the image silhouette to clean up the
            transparent-edge bleed on the PokeAPI badge PNGs. The
            filter erodes the alpha channel by 1px, takes the
            difference (a 1px ring along the inside edge), floods it
            black, and composites back over the original. Inlined
            here so it's available whenever the trainer card is
            mounted; SVG filter ids are global so any element using
            url(#badge-inner-stroke) can reach it. */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
          <defs>
            <filter id="badge-inner-stroke">
              <feMorphology operator="erode" radius="1" in="SourceAlpha" result="inner" />
              <feComposite in="SourceAlpha" in2="inner" operator="out" result="ring" />
              <feFlood floodColor="#000" />
              <feComposite in2="ring" operator="in" result="stroke" />
              <feComposite in="stroke" in2="SourceGraphic" operator="over" />
            </filter>
          </defs>
        </svg>
        <header className="g-modal-head">
          <h2>Trainer Card</h2>
          <button className="g-modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="g-modal-body">
          {me && (
            <section className="g-profile-hero">
              <div className="g-avatar">{initial}</div>
              <div className="g-profile-info">
                <div className="g-profile-name">{me.name ?? me.username}</div>
                <div className="g-profile-handle">@{me.username}</div>
              </div>
              <div className="g-profile-stats">
                <div className="g-stat-pill"><strong><CountUp value={me.accountLevel} /></strong><span>Level</span></div>
                <div className="g-stat-pill"><strong>$<CountUp value={state.money} /></strong><span>Money</span></div>
                <div className="g-stat-pill">
                  <strong className={state.championDefeated ? "g-stat-on" : ""}>
                    {state.championDefeated ? "Champ" : "—"}
                  </strong>
                  <span>Status</span>
                </div>
              </div>
            </section>
          )}

          <div className="g-grid">
            <section className="g-card">
              <h3>Battle Record</h3>
              <div className="g-row"><span>Wild victories</span><strong>{state.wildBattlesWon.toLocaleString()}</strong></div>
              <div className="g-row"><span>Trainer victories</span><strong>{state.trainerBattlesWon.toLocaleString()}</strong></div>
              <div className="g-row"><span>Elite Four</span><strong>{state.defeatedEliteFour.length}<span className="dim"> / {totalE4}</span></strong></div>
              <div className="g-row"><span>Champion</span><strong>{state.championDefeated ? "Defeated" : <span className="dim">Pending</span>}</strong></div>
            </section>

            <section className="g-card">
              <h3>Collection</h3>
              <div className="g-row"><span>Caught</span><strong>{state.pokedexCaught.length}<span className="dim"> / {totalDex}</span></strong></div>
              <div className="g-row"><span>Seen</span><strong>{state.pokedexSeen.length}</strong></div>
              <div className="g-row"><span>Shiny</span><strong>{state.shinyCaught.length}</strong></div>
              <div className="g-row"><span>Badges</span><strong>{state.defeatedGyms.length}<span className="dim"> / {totalGyms}</span></strong></div>
            </section>
          </div>

          <section className="g-card g-card-full">
            <h3>Gym Badges</h3>
            <div className="g-badge-grid">
              {gymLeaders.map((g, i) => {
                const earned = state.defeatedGyms.includes(g.id);
                // PokeAPI hosts the eight Kanto badges at sprites/badges/
                // 1.png … 8.png in their sprite repo, in the same order
                // as our gymLeaders array (Brock, Misty, Surge, Erika,
                // Koga, Sabrina, Blaine, Giovanni). Pull from the GitHub
                // raw URL — locked badges render the same image with a
                // grayscale + low-opacity filter applied via CSS.
                const badgeUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/badges/${i + 1}.png`;
                return (
                  <div
                    key={g.id}
                    className={`g-badge ${earned ? "earned" : ""}`}
                    title={earned ? `${g.badgeName} — defeated ${g.name}` : `${g.name} (${g.locationKey}) — not yet defeated`}
                  >
                    <div className="g-badge-disc">
                      <img
                        src={badgeUrl}
                        alt={g.badgeName}
                        width={48}
                        height={48}
                        style={{ imageRendering: "pixelated" }}
                      />
                    </div>
                    <div className="g-badge-name">{earned ? g.badgeName : "Locked"}</div>
                    <div className="g-badge-leader">{g.name}</div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="g-modal-foot">
          <button className="g-btn-primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}

// --- Public card -----------------------------------------------------------

type FriendRel = "none" | "outgoing" | "incoming" | "accepted";

function PublicCard({ username, onClose }: { username: string; onClose?: () => void }) {
  const { me } = useAuth();
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [friendRel, setFriendRel] = useState<FriendRel>("none");
  const [friendBusy, setFriendBusy] = useState(false);
  const tradeState = useTradeState();

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);
    setFriendRel("none");
    Promise.all([
      api.publicProfile(username),
      api.listFriends().catch(() => null),
    ]).then(([p, friends]) => {
      if (cancelled) return;
      setProfile(p);
      // Determine the current relationship by looking up `p` in each
      // bucket. The friends API returns id-keyed entries we can match
      // against the loaded profile's id.
      if (friends) {
        if (friends.accepted.some((f) => f.id === p.id)) setFriendRel("accepted");
        else if (friends.outgoing.some((f) => f.id === p.id)) setFriendRel("outgoing");
        else if (friends.incoming.some((f) => f.id === p.id)) setFriendRel("incoming");
        else setFriendRel("none");
      }
    }).catch((e) => {
      if (!cancelled) setError(e?.message ?? "Could not load profile.");
    });
    return () => { cancelled = true; };
  }, [username]);

  const close = () => onClose?.();
  const isSelf = me && profile && me.id === profile.id;
  const inActiveTrade = !!tradeState.room || !!tradeState.invite;

  const requestTrade = () => {
    if (!profile || isSelf || inActiveTrade) return;
    setBusy(true);
    setError(null);
    sendTradeInvite(profile.id, (res) => {
      setBusy(false);
      if (res.ok) {
        setInviteSent(true);
      } else {
        setError(res.error ?? "Could not send invite.");
      }
    });
  };

  const friendAction = async () => {
    if (!profile || isSelf || friendBusy) return;
    setFriendBusy(true);
    setError(null);
    try {
      if (friendRel === "incoming") {
        // The other side already requested us — accept theirs.
        const list = await api.listFriends();
        const entry = list.incoming.find((f) => f.id === profile.id);
        if (entry) {
          await api.acceptFriend(entry.friendshipId);
          setFriendRel("accepted");
        }
      } else if (friendRel === "none") {
        // Send a fresh request. The server will auto-accept if they
        // already requested us (the request endpoint handles both).
        const res = await api.requestFriend(profile.username);
        setFriendRel(res.status === "accepted" ? "accepted" : "outgoing");
      }
    } catch (e: any) {
      setError(e?.message ?? "Could not send friend request.");
    } finally {
      setFriendBusy(false);
    }
  };

  const initial = (profile?.name ?? profile?.username ?? username)[0]?.toUpperCase() ?? "?";

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        ref={dialogRef}
        className="g-modal trainer-card-modal-v2"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Trainer card for ${username}`}
      >
        <header className="g-modal-head">
          <h2>Trainer Card</h2>
          <button className="g-modal-close" onClick={close} aria-label="Close">×</button>
        </header>

        <div className="g-modal-body">
          {!profile && !error && (
            <p className="dim small" style={{ padding: 16 }}>Loading…</p>
          )}
          {error && <p className="auth-error">{error}</p>}
          {profile && (
            <>
              <section className="g-profile-hero">
                <div className="g-avatar">{initial}</div>
                <div className="g-profile-info">
                  <div className="g-profile-name">{profile.name ?? profile.username}</div>
                  <div className="g-profile-handle">@{profile.username}</div>
                </div>
                <div className="g-profile-stats">
                  <div className="g-stat-pill"><strong><CountUp value={profile.accountLevel} /></strong><span>Level</span></div>
                  <div className="g-stat-pill"><strong><CountUp value={profile.pokedexCaughtCount} /></strong><span>Caught</span></div>
                  <div className="g-stat-pill"><strong><CountUp value={profile.totalCaughtLevels} /></strong><span>Σ Lv</span></div>
                </div>
              </section>

              <section className="g-card g-card-full">
                <h3>Trainer</h3>
                <div className="g-row"><span>Joined</span><strong>{new Date(profile.createdAt).toLocaleDateString()}</strong></div>
                <div className="g-row"><span>Last seen</span><strong>{new Date(profile.lastSeenAt).toLocaleString()}</strong></div>
                <div className="g-row"><span>Pokémon caught</span><strong>{profile.pokedexCaughtCount}</strong></div>
                <div className="g-row"><span>Σ Pokémon levels</span><strong>{profile.totalCaughtLevels.toLocaleString()}</strong></div>
              </section>
            </>
          )}
        </div>

        <footer className="g-modal-foot">
          {!isSelf && profile && (
            <>
              <button
                className={friendRel === "accepted" ? "g-btn-ghost" : "g-btn-ghost"}
                onClick={friendAction}
                disabled={
                  friendBusy ||
                  friendRel === "accepted" ||
                  friendRel === "outgoing"
                }
                title={
                  friendRel === "accepted" ? "Already friends"
                  : friendRel === "outgoing" ? "Friend request sent — waiting for response"
                  : friendRel === "incoming" ? "Accept their pending friend request"
                  : "Send a friend request"
                }
              >
                {friendBusy ? "…"
                  : friendRel === "accepted" ? "✓ Friends"
                  : friendRel === "outgoing" ? "Request sent"
                  : friendRel === "incoming" ? "Accept friend"
                  : "Add friend"}
              </button>
              <button
                className="g-btn-primary"
                onClick={requestTrade}
                disabled={busy || inviteSent || inActiveTrade || friendRel !== "accepted"}
                title={
                  friendRel !== "accepted" ? "Add as friend before trading"
                  : inActiveTrade ? "You're already in a trade"
                  : inviteSent ? "Invite sent — waiting for response"
                  : undefined
                }
              >
                {inviteSent ? "Invite sent ✓" : busy ? "…" : "Request trade"}
              </button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button className="g-btn-ghost" onClick={close}>Close</button>
        </footer>
      </div>
    </div>
  );
}
