// Manage people, for admins: who's what (admin, household, guest), removing people, letting them back in,
// and deleting someone who was removed along with everything they did.
import { useEffect, useState } from "react";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { useLiveState, useNow } from "./live";
import { Nav, navigate } from "./Nav";
import * as house from "./house";
import { reason, ROLE_NAMES, ROLES, tint, useMe, when, type Person } from "./house";
import { AROUND_MS } from "./People";
import { useUndoToast } from "./Undo";
import type { State } from "./slides";

export function Manage() {
  const { me } = useMe();
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 30_000);
  const toast = useUndoToast();
  /** Who's being asked about: deleting someone takes a second press. */
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Manage people · Papershow";
  }, []);

  // Only admins manage people; anyone else lands back on the house.
  const admin = me.role === "admin";
  useEffect(() => {
    if (!admin) navigate("/people");
  }, [admin]);

  const everyone = state?.people ?? [];
  const inside = everyone.filter((p) => p.status === "in");
  const out = everyone.filter((p) => p.status === "out");
  const admins = inside.filter((p) => p.role === "admin").length;

  /** Run a change; show what went wrong in a toast instead of failing quietly. */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      const next = await fn();
      if (next && typeof next === "object" && "sequence" in next) accept(next as State);
      if (done) toast.show(done);
    } catch (e) {
      toast.show(reason(e, "That didn't work"));
    }
  };

  const remove = (p: Person) =>
    act(async () => {
      const next = await house.updatePerson(p.id, { status: "out" });
      toast.show(`${p.name} is out`, () => act(() => house.updatePerson(p.id, { status: "in" })));
      return next;
    });

  const deleteAll = (p: Person) =>
    act(async () => {
      setDeleting(null);
      const next = await house.deleteEverything(p.id);
      const { drawings, apps, playlists } = next.deleted;
      const made = [
        drawings && `${drawings} drawing${drawings > 1 ? "s" : ""}`,
        apps && `${apps} app${apps > 1 ? "s" : ""}`,
        playlists && `${playlists} playlist${playlists > 1 ? "s" : ""}`,
      ].filter(Boolean);
      toast.show(`${p.name} is gone${made.length ? `, with ${made.join(", ")}` : ""} 🧹`);
      return next;
    });

  if (!admin) return null;
  return (
    <div className="app people-page">
      <header className="bar">
        <div className="bar-left">
          <Nav current="people" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>

      <main className="people-main">
        <section className="people-section">
          <div className="section-head">
            <h2>Manage people</h2>
            <a className="ghost" href="/people" onClick={(e) => (e.preventDefault(), navigate("/people"))}>
              Back to the house
            </a>
          </div>
          <p className="muted manage-intro">
            <strong>Admins</strong> run the house. <strong>Household</strong> make things, run the show and let people in.{" "}
            <strong>Guests</strong> draw and make apps, and ask before anything goes on the panel.
          </p>
          <ul className="manage-list">
            {inside.map((p) => {
              const around = p.seenAt !== null && now - p.seenAt < AROUND_MS;
              const lastAdmin = p.role === "admin" && admins <= 1;
              return (
                <li key={p.id}>
                  <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span>
                  <span className="manage-who">
                    <strong>{p.name}{p.id === me.id ? " (you)" : ""}</strong>
                    <small className="muted">{around ? "Around now" : p.seenAt ? `Seen ${when(p.seenAt, now)}` : "Not seen yet"}</small>
                  </span>
                  <div className="segmented" role="radiogroup" aria-label={`${p.name}'s role`}>
                    {ROLES.map((r) => (
                      <button
                        key={r}
                        role="radio"
                        aria-checked={p.role === r}
                        disabled={lastAdmin && r !== "admin"}
                        title={lastAdmin && r !== "admin" ? "Someone has to stay an admin" : undefined}
                        onClick={() => p.role !== r && act(() => house.updatePerson(p.id, { role: r }))}
                      >
                        {ROLE_NAMES[r]}
                      </button>
                    ))}
                  </div>
                  {p.id !== me.id && (
                    <button className="ghost danger" disabled={lastAdmin} onClick={() => remove(p)}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="people-section">
          <h2>Removed</h2>
          {out.length ? (
            <>
              <p className="muted manage-intro">
                They can't sign in, and what they made stays. Let them back in, or delete them with everything they did:
                their drawings, apps and playlists, and every line about them in the log.
              </p>
              <ul className="manage-list">
                {out.map((p) => (
                  <li key={p.id}>
                    <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span>
                    <span className="manage-who">
                      <strong>{p.name}</strong>
                    </span>
                    {deleting === p.id ? (
                      <span className="manage-confirm">
                        <span>Delete {p.name} and everything they did? This can't be undone.</span>
                        <button className="ghost" onClick={() => setDeleting(null)}>Keep</button>
                        <button className="danger-solid" onClick={() => deleteAll(p)}>Delete everything</button>
                      </span>
                    ) : (
                      <>
                        <button className="ghost" onClick={() => act(() => house.updatePerson(p.id, { status: "in" }), `${p.name} is back 🎉`)}>
                          Let back in
                        </button>
                        <button className="ghost danger" onClick={() => setDeleting(p.id)}>
                          Delete everything
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted people-empty">No one.</p>
          )}
        </section>
      </main>
      {toast.node}
    </div>
  );
}
