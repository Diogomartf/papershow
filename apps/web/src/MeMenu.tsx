// Your face in the top-right corner, and the menu behind it: who you are, everyone else in the house to
// switch to (a shared tablet changes hands), the house, the log and signing out. The household also sees who's knocking.
import { useEffect, useRef, useState } from "react";
import { ROLE_NAMES, signOut, tint, useMe } from "./house";
import { useLiveState } from "./live";
import { navigate } from "./Nav";
import { cue, setSound, useSound } from "./sound";

export function MeMenu() {
  const { me, refresh, switchTo } = useMe();
  const { state } = useLiveState();
  const [open, setOpen] = useState(false);
  const sound = useSound();
  const root = useRef<HTMLDivElement>(null);

  const self = state?.me ?? me;
  const everyone = state?.people ?? [];
  // Knocks and guests' asks wait for anyone in the household; a guest's own ask shows on the Dashboard instead.
  const knocking = self.role === "guest" ? [] : everyone.filter((p) => p.status === "knocking");
  const asks = self.role === "guest" ? [] : (state?.asks ?? []);
  const waiting = knocking.length + asks.length;
  const others = everyone.filter((p) => p.status === "in" && p.id !== self.id);

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (cue(["close", { emphasis: "subtle" }]), setOpen(false));
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", away), removeEventListener("keydown", esc));
  }, [open]);

  const go = (to: string) => (setOpen(false), navigate(to));

  return (
    <div className="me-menu" ref={root}>
      <button
        className="me-chip"
        style={tint(self.color)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={waiting ? `${self.name}: ${waiting} waiting for you` : self.name}
        title={self.name}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>{self.face}</span>
        {waiting > 0 && <span className="knock-badge">{waiting}</span>}
      </button>
      {open && (
        <div className="me-pop" role="menu">
          {knocking.map((p) => (
            <button key={p.id} role="menuitem" className="me-item knock-item" onClick={() => go("/people")}>
              <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span>
              <span><strong>{p.name}</strong> is knocking</span>
            </button>
          ))}
          {asks.map((a) => {
            const p = everyone.find((x) => x.id === a.by);
            return (
              <button key={a.id} role="menuitem" className="me-item knock-item" onClick={() => go("/")}>
                <span className="face-mini" style={tint(p?.color ?? "#ccc")} aria-hidden>{p?.face ?? "👤"}</span>
                <span><strong>{p?.name ?? "A guest"}</strong> asks to show something</span>
              </button>
            );
          })}
          <div className="me-head">
            <span className="face-badge small" style={tint(self.color)} aria-hidden>{self.face}</span>
            <span>
              <strong>{self.name}</strong>
              <small>{self.role === "admin" ? "👑 Admin" : ROLE_NAMES[self.role]}</small>
            </span>
          </div>
          {others.length > 0 && (
            <>
              <span className="me-label">Switch to</span>
              {others.map((p) => (
                <button key={p.id} role="menuitem" className="me-item" onClick={() => (setOpen(false), switchTo(p.id))}>
                  <span className="face-mini" style={tint(p.color)} aria-hidden>{p.face}</span>
                  {p.name}
                </button>
              ))}
            </>
          )}
          <hr />
          {/* This device's, like the lights: a shared tablet in the kitchen can stay quiet. */}
          <button role="menuitemcheckbox" aria-checked={sound} className="me-item me-sound" data-quiet onClick={() => setSound(!sound)}>
            Sound
            <span className="me-sound-state">{sound ? "On" : "Off"}</span>
          </button>
          <button role="menuitem" className="me-item" onClick={() => go("/people")}>The house</button>
          {self.role !== "guest" && <button role="menuitem" className="me-item" onClick={() => go("/log")}>Log</button>}
          <button
            role="menuitem"
            className="me-item"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate("/");
              refresh();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
