// The house: who's knocking, you, everyone else, and inviting someone new.
import { useEffect, useState } from "react";
import { Keypad } from "./Hello";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { useLiveState, useNow } from "./live";
import { Nav, navigate } from "./Nav";
import * as house from "./house";
import { says, tint, useMe, when, type Invite, type Person } from "./house";
import { useUndoToast } from "./Undo";

/** Seen in the last five minutes: around right now. */
const AROUND_MS = 5 * 60_000;

export function People() {
  const { me, hello, refresh } = useMe();
  const { state, accept, skew } = useLiveState();
  const now = useNow(skew, 30_000);
  const toast = useUndoToast();
  const [editing, setEditing] = useState<"look" | "secret" | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);

  useEffect(() => {
    document.title = "The house · Papershow";
  }, []);

  const admin = me.role === "admin";
  const everyone = state?.people ?? [];
  const self = state?.me ?? me;
  const knocking = everyone.filter((p) => p.status === "knocking");
  const others = everyone.filter((p) => p.status === "in" && p.id !== self.id);
  const out = everyone.filter((p) => p.status === "out");
  const admins = everyone.filter((p) => p.status === "in" && p.role === "admin").length;

  /** Run an admin action; show what went wrong in a toast instead of failing quietly. */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      const next = await fn();
      if (next && typeof next === "object" && "sequence" in next) accept(next as Parameters<typeof accept>[0]);
      if (done) toast.show(done);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "That didn't work");
    }
  };

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
        {admin && knocking.length > 0 && (
          <section className="people-section">
            <h2>At the door</h2>
            <ul className="knock-list">
              {knocking.map((p) => (
                <li key={p.id} className="knock-card">
                  <span className="face-badge small" style={tint(p.color)} aria-hidden>{p.face}</span>
                  <div className="knock-text">
                    <strong>{p.name} is knocking</strong>
                    <span className="muted">{when(p.createdAt, now)}</span>
                  </div>
                  <div className="knock-actions">
                    <button className="big-yes" onClick={() => act(() => house.updatePerson(p.id, { status: "in" }), `${p.face} ${p.name} is in! 🎉`)}>
                      Let in
                    </button>
                    <button className="ghost" onClick={() => act(() => house.notNow(p.id))}>
                      Not now
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="people-section">
          <h2>You</h2>
          <div className="you-card">
            <span className="face-badge" style={tint(self.color)} aria-hidden>{self.face}</span>
            <div className="you-text">
              <strong className="you-name">{self.name}</strong>
              <span className="muted">{self.role === "admin" ? "👑 Admin: you let people in" : "In the house"}</span>
            </div>
            <div className="you-actions">
              <button className="ghost" onClick={() => setEditing(editing === "look" ? null : "look")} aria-expanded={editing === "look"}>
                New look
              </button>
              <button className="ghost" onClick={() => setEditing(editing === "secret" ? null : "secret")} aria-expanded={editing === "secret"}>
                New PIN
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await house.signOut();
                  navigate("/");
                  refresh();
                }}
              >
                Sign out
              </button>
            </div>
          </div>
          {editing === "look" && (
            <LookEditor
              me={self}
              faces={hello.faces}
              colors={hello.colors}
              onSave={async (p) => {
                await house.updateMe(p);
                refresh();
                setEditing(null);
                toast.show("Looking good ✨");
              }}
            />
          )}
          {editing === "secret" && (
            <SecretEditor
              keys={hello.keys}
              onSave={async (secret) => {
                await house.updateMe({ secret });
                setEditing(null);
                toast.show("New PIN saved 🤫");
              }}
            />
          )}
        </section>

        <section className="people-section">
          <div className="section-head">
            <h2>The house</h2>
            {admin && (
              <button className="primary" onClick={() => act(async () => setInvite(await house.createInvite(false)))}>
                Invite someone 🎟️
              </button>
            )}
          </div>
          {others.length ? (
            <ul className="house-grid">
              {others.map((p) => (
                <li key={p.id}>
                  <PersonTile
                    p={p}
                    now={now}
                    admin={admin}
                    lastAdmin={p.role === "admin" && admins <= 1}
                    onRole={(role) => act(() => house.updatePerson(p.id, { role }))}
                    onRemove={() =>
                      act(async () => {
                        const next = await house.updatePerson(p.id, { status: "out" });
                        toast.show(`${p.name} is out`, () => act(() => house.updatePerson(p.id, { status: "in" })));
                        return next;
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted people-empty">
              Just you so far.{admin ? " Invite someone, or have them open Papershow and tap “I'm new”." : ""}
            </p>
          )}
        </section>

        {admin && out.length > 0 && (
          <section className="people-section">
            <h2>Removed</h2>
            <ul className="out-list">
              {out.map((p) => (
                <li key={p.id}>
                  <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span>
                  <span>{p.name}</span>
                  <button className="ghost" onClick={() => act(() => house.updatePerson(p.id, { status: "in" }), `${p.name} is back 🎉`)}>
                    Let back in
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="people-section">
          <div className="section-head">
            <h2>Lately</h2>
            <a className="ghost" href="/log" onClick={(e) => (e.preventDefault(), navigate("/log"))}>
              Whole log
            </a>
          </div>
          <LogList entries={state?.log ?? []} people={everyone} now={now} />
        </section>
      </main>

      {invite && (
        <InviteSheet
          invite={invite}
          onPanel={(panel) =>
            act(async () => {
              // On the panel needs an invite made for it; taking it off keeps this one working here.
              if (panel) setInvite(await house.createInvite(true));
              else {
                await house.hideInvite(invite.code);
                setInvite({ ...invite, onPanel: false });
              }
            })
          }
          onClose={() => {
            if (invite.onPanel) void house.hideInvite(invite.code);
            setInvite(null);
          }}
        />
      )}
      {toast.node}
    </div>
  );
}

function PersonTile({
  p,
  now,
  admin,
  lastAdmin,
  onRole,
  onRemove,
}: {
  p: Person;
  now: number;
  admin: boolean;
  lastAdmin: boolean;
  onRole: (role: house.Role) => void;
  onRemove: () => void;
}) {
  const around = p.seenAt !== null && now - p.seenAt < AROUND_MS;
  return (
    <div className="person-tile">
      <span className="face-badge small" style={tint(p.color)} aria-hidden>
        {p.face}
        {around && <span className="around" title="Around now" />}
      </span>
      <strong>
        {p.name}
        {p.role === "admin" && <span title="Admin"> 👑</span>}
      </strong>
      <span className="muted">{around ? "Around now" : p.seenAt ? `Seen ${when(p.seenAt, now)}` : "Not seen yet"}</span>
      {admin && (
        <div className="person-actions">
          {p.role === "admin" ? (
            <button className="link" disabled={lastAdmin} onClick={() => onRole("member")}>
              Not admin
            </button>
          ) : (
            <button className="link" onClick={() => onRole("admin")}>
              Make admin
            </button>
          )}
          <button className="link danger" disabled={lastAdmin} onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function LookEditor({
  me,
  faces,
  colors,
  onSave,
}: {
  me: Person;
  faces: string[];
  colors: string[];
  onSave: (p: house.Profile) => Promise<void>;
}) {
  const [name, setName] = useState(me.name);
  const [face, setFace] = useState(me.face);
  const [color, setColor] = useState(me.color);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="editor-card"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave({ name, face, color });
        } catch (err) {
          setError(err instanceof Error ? err.message : "That didn't work");
        }
      }}
    >
      <label className="door-label" htmlFor="me-name">Name</label>
      <input id="me-name" className="door-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
      <div className="face-grid" role="radiogroup" aria-label="Face">
        {faces.map((f) => (
          <button type="button" key={f} role="radio" aria-checked={f === face} className="face-pick" onClick={() => setFace(f)}>
            {f}
          </button>
        ))}
      </div>
      <div className="color-row" role="radiogroup" aria-label="Colour">
        {colors.map((c) => (
          <button type="button" key={c} role="radio" aria-checked={c === color} className="color-pick" style={tint(c)} onClick={() => setColor(c)} aria-label={c} />
        ))}
      </div>
      <div className="editor-actions">
        <span className="face-badge small" style={tint(color)} aria-hidden>{face}</span>
        <button className="primary" type="submit" disabled={!name.trim()}>
          Save
        </button>
        {error && <span className="door-hint">{error}</span>}
      </div>
    </form>
  );
}

function SecretEditor({ keys, onSave }: { keys: string[]; onSave: (secret: string[]) => Promise<void> }) {
  const [first, setFirst] = useState<string[] | null>(null);
  const [wrong, setWrong] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  return (
    <div className="editor-card secret-editor">
      <p className="door-intro">{first ? "Once more, to be sure" : "Tap 4 new numbers"}</p>
      <Keypad
        key={first ? "again" : `first-${wrong}`}
        keys={keys}
        onDone={async (s) => {
          if (!first) return setFirst(s), setHint(null);
          if (s.join("") !== first.join("")) {
            setFirst(null);
            setWrong((n) => n + 1);
            return setHint("Those don't match. Start again?");
          }
          await onSave(s);
        }}
      />
      <p className="door-hint" role="status">{hint ?? " "}</p>
    </div>
  );
}

/** The invite as a QR code to scan off this screen, with the option to put it on the panel too. */
function InviteSheet({ invite, onPanel, onClose }: { invite: Invite; onPanel: (on: boolean) => void; onClose: () => void }) {
  const now = useNow(0, 1000);
  const left = Math.max(0, invite.expiresAt - now);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" data-on onClick={onClose} />
      <div className="invite-sheet" role="dialog" aria-label="Invite someone">
        <h2>Come in! 🎟️</h2>
        <p className="muted">Scan with a phone's camera, on the home Wi-Fi.</p>
        {left > 0 ? (
          <>
            <img className="invite-qr" src={house.inviteQr(invite.code)} alt={`QR code for ${invite.url}`} />
            <p className="invite-code">{invite.code}</p>
            <p className="muted tabular">
              Works for {Math.floor(left / 60_000)}:{String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")} · or open{" "}
              <code>{invite.url.replace(/^https?:\/\//, "")}</code>
            </p>
          </>
        ) : (
          <p className="invite-code">This invite ran out.</p>
        )}
        <div className="invite-actions">
          <label className="night-row">
            <span>Show it on the panel</span>
            <button
              className="toggle"
              role="switch"
              aria-checked={invite.onPanel}
              disabled={left <= 0}
              onClick={() => onPanel(!invite.onPanel)}
            >
              <span />
            </button>
          </label>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

/** Who did what, newest first. */
export function LogList({ entries, people: everyone, now }: { entries: house.LogEntry[]; people: Person[]; now: number }) {
  if (!entries.length) return <p className="muted people-empty">Nothing yet.</p>;
  const byId = new Map(everyone.map((p) => [p.id, p]));
  return (
    <ol className="log-list">
      {entries.map((e) => {
        const p = e.personId ? byId.get(e.personId) : undefined;
        return (
          <li key={e.id}>
            <span className="face-mini" style={tint(p?.color ?? "#ccc")} aria-hidden>{p?.face ?? "👤"}</span>
            <span className="log-text">
              <strong>{p?.name ?? "Someone"}</strong> {says(e)}
            </span>
            <time className="muted" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
              {when(e.at, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
