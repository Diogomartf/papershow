// The front door: who's there, your secret, joining, knocking. Made for thumbs and kids: big
// tiles, one thing per screen, and no typing beyond your name.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as house from "./house";
import { tint, type Face, type Hello as HelloData, type Profile } from "./house";
import { cue } from "./sound";

type Props = {
  hello: HelloData;
  /** An invite code from a /join/<code> link. */
  joinCode: string | null;
  /** Go in: this device is now signed in as someone who's in. */
  onIn: (h: HelloData) => void;
  /** Open on this person's PIN (switching profiles). */
  startAs?: string | null;
};

type Stage =
  | { at: "faces" }
  | { at: "secret"; who: Face }
  | { at: "join"; invite: string | null }
  | { at: "knocking"; name: string }
  | { at: "welcome"; h: HelloData; line: string }
  | { at: "not-now" };

export function Hello({ hello, joinCode, onIn, startAs }: Props) {
  const [h, setH] = useState(hello);
  const [stage, setStage] = useState<Stage>(() => {
    if (hello.me?.status === "knocking") return { at: "knocking", name: hello.me.name };
    if (joinCode) return { at: "join", invite: joinCode };
    const who = startAs && hello.people.find((p) => p.id === startAs);
    return who ? { at: "secret", who } : { at: "faces" };
  });

  useEffect(() => {
    document.title = "Papershow";
  }, []);

  // Let in: the confetti moment. Knocked: a quiet ready. Turned away: a muted no.
  useEffect(() => {
    if (stage.at === "welcome") cue(["success", { emphasis: "strong" }]);
    if (stage.at === "not-now") cue("error");
  }, [stage.at]);

  // Knocking: wait for an admin. The server answers as soon as anything changes.
  useEffect(() => {
    if (stage.at !== "knocking") return;
    let on = true;
    (async () => {
      while (on) {
        try {
          const next = await house.hello(true);
          if (!on) return;
          if (next.me?.status === "in") return setStage({ at: "welcome", h: next, line: `Come in, ${next.me.name}!` });
          if (!next.me) return setStage({ at: "not-now" });
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => {
      on = false;
    };
  }, [stage.at]);

  if (h.first) {
    return (
      <Door>
        <Join
          title="You're the first one here!"
          intro="Set up the house. You'll be its admin: you let people in."
          hello={h}
          onDone={async (p, secret) => {
            const next = await house.setUp(p, secret);
            setH(next);
            setStage({ at: "welcome", h: next, line: `Welcome home, ${p.name}!` });
          }}
        />
      </Door>
    );
  }

  switch (stage.at) {
    case "faces":
      return (
        <Door>
          <div className="door-center wide">
            <h1 className="door-title">Who's there? <span className="wave">👋</span></h1>
            <ul className="door-faces">
              {h.people.map((p) => (
                <li key={p.id}>
                  <button className="profile" data-cuelume-select onClick={() => setStage({ at: "secret", who: p })}>
                    <span className="profile-pic" style={tint(p.color)} aria-hidden>{p.face}</span>
                    <span className="profile-name">{p.name}</span>
                  </button>
                </li>
              ))}
              <li>
                <button className="profile new" onClick={() => setStage({ at: "join", invite: null })}>
                  <span className="profile-pic" aria-hidden>＋</span>
                  <span className="profile-name">I'm new</span>
                </button>
              </li>
            </ul>
          </div>
        </Door>
      );

    case "secret":
      return (
        <Door onBack={() => setStage({ at: "faces" })}>
          <SignIn who={stage.who} keys={h.keys} onIn={onIn} />
        </Door>
      );

    case "join":
      return (
        <Door onBack={joinCode ? undefined : () => setStage({ at: "faces" })}>
          <Join
            title="Hello, new friend!"
            intro={stage.invite ? "Tell us who you are, and you're in." : "Tell us who you are. Someone in the house lets you in."}
            hello={h}
            invite={stage.invite}
            onDone={async (p, secret, invite) => {
              const next = await house.knock(p, secret, invite ?? undefined);
              history.replaceState(null, "", "/");
              setH(next);
              if (next.me?.status === "in") setStage({ at: "welcome", h: next, line: `Welcome home, ${p.name}!` });
              else setStage({ at: "knocking", name: p.name });
            }}
          />
        </Door>
      );

    case "knocking":
      return (
        <Door>
          <div className="door-center">
            <div className="knock" aria-hidden>🚪</div>
            <h1 className="door-title">Knock knock!</h1>
            <p className="door-intro">
              Hang on, {stage.name}. Someone in the house will let you in soon.
              <br />
              This page opens by itself when they do.
            </p>
            <button
              className="door-link"
              onClick={async () => {
                setH(await house.signOut());
                setStage({ at: "faces" });
              }}
            >
              Never mind
            </button>
          </div>
        </Door>
      );

    case "welcome":
      return (
        <Door>
          <div className="door-center">
            <Confetti />
            <div className="party" aria-hidden>🎉</div>
            <h1 className="door-title">{stage.line}</h1>
            <p className="door-intro">Draw something, set up an app, and put it on the panel for everyone to see.</p>
            <button className="door-go" onClick={() => onIn(stage.h)} autoFocus>
              Let's go
            </button>
          </div>
        </Door>
      );

    case "not-now":
      return (
        <Door>
          <div className="door-center">
            <div className="party" aria-hidden>🙈</div>
            <h1 className="door-title">Not this time</h1>
            <p className="door-intro">Nobody let you in just now. Ask someone in the house, then try again.</p>
            <button
              className="door-go"
              onClick={async () => {
                setH(await house.hello());
                setStage({ at: "faces" });
              }}
            >
              OK
            </button>
          </div>
        </Door>
      );
  }
}

function Door({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <div className="door">
      <header className="door-bar">
        {onBack ? (
          <button className="door-back" data-quiet onClick={() => (cue(["navigate", { direction: "back" }]), onBack())} aria-label="Back">
            ←
          </button>
        ) : (
          <span />
        )}
        <span className="wordmark" role="img" aria-label="Papershow" />
        <span />
      </header>
      <main className="door-main">{children}</main>
    </div>
  );
}

/** Tap your secret. Wrong: the dots wiggle. Too many wrong: wait a bit. */
function SignIn({ who, keys, onIn }: { who: Face; keys: string[]; onIn: (h: HelloData) => void }) {
  const [wrong, setWrong] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lockedUntil) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= lockedUntil) setLockedUntil(null);
    }, 500);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const locked = lockedUntil !== null && lockedUntil > now;

  return (
    <div className="door-center">
      <div className="face-badge" style={tint(who.color)} aria-hidden>{who.face}</div>
      <h1 className="door-title">Hi {who.name}! What's your PIN?</h1>
      <Keypad
        key={wrong}
        keys={keys}
        wrong={wrong}
        disabled={locked}
        onDone={async (secret) => {
          try {
            onIn(await house.signIn(who.id, secret));
          } catch (e) {
            const body = e instanceof house.Oops ? e.body : {};
            setWrong((n) => n + 1);
            if (typeof body.lockedUntil === "number") setLockedUntil(body.lockedUntil);
            const left = body.triesLeft;
            setHint(typeof left === "number" && left > 0 && left <= 3 ? `Not quite. ${left} more ${left === 1 ? "try" : "tries"}.` : "Not quite. Try again!");
          }
        }}
      />
      <p className="door-hint" role="status">
        {locked ? `Too many tries. Have a rest for ${Math.ceil((lockedUntil! - now) / 1000)} s.` : hint ?? " "}
      </p>
    </div>
  );
}

/** A 4-digit PIN, tapped (or typed) in order. Give it a new `key` to start over; a `wrong` count above 0 wiggles the dots as it appears. */
export function Keypad({
  keys,
  wrong = 0,
  disabled,
  onDone,
}: {
  keys: string[];
  wrong?: number;
  disabled?: boolean;
  onDone: (secret: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const dots = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wrong) return;
    cue("error");
    dots.current?.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-12px)" }, { transform: "translateX(10px)" }, { transform: "translateX(-6px)" }, { transform: "translateX(0)" }],
      { duration: 360, easing: "ease-out" },
    );
  }, [wrong]);

  const tap = (k: string) => {
    if (disabled || picked.length >= 4) return;
    const next = [...picked, k];
    setPicked(next);
    // A beat to see the last dot fill before it's checked.
    if (next.length === 4) setTimeout(() => onDone(next), 180);
  };
  const undo = () => setPicked((p) => p.slice(0, -1));

  // On a computer, the number keys work too.
  const keyboard = useRef({ tap, undo });
  useEffect(() => {
    keyboard.current = { tap, undo };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === "INPUT") return;
      if (keys.includes(e.key)) {
        cue(["type", { key: "printable" }]);
        keyboard.current.tap(e.key);
      } else if (e.key === "Backspace") {
        cue(["type", { key: "delete" }]);
        keyboard.current.undo();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [keys]);

  // Phone order: 1–9 in three rows, then 0 in the middle of the last one.
  const zero = keys[keys.length - 1];
  return (
    <div className="keypad-wrap">
      <div className="secret-dots" ref={dots} role="status" aria-label={`${picked.length} of 4 digits`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="secret-dot" data-on={i < picked.length} />
        ))}
      </div>
      <div className="keypad" data-disabled={disabled}>
        {keys.slice(0, -1).map((k) => (
          <button key={k} className="key" data-quiet onClick={() => (cue(["type", { key: "printable" }]), tap(k))} disabled={disabled}>
            {k}
          </button>
        ))}
        <span aria-hidden />
        <button className="key" data-quiet onClick={() => (cue(["type", { key: "printable" }]), tap(zero))} disabled={disabled}>
          {zero}
        </button>
        <button className="key undo" data-quiet onClick={() => (cue(["type", { key: "delete" }]), undo())} disabled={!picked.length || disabled} aria-label="Undo">
          ⌫
        </button>
      </div>
    </div>
  );
}

type JoinStep = "name" | "face" | "secret" | "again";

/** Name, face, secret, secret again. Used for setting up the house and for joining it. */
function Join({
  title,
  intro,
  hello,
  invite: initialInvite = null,
  onDone,
}: {
  title: string;
  intro: string;
  hello: HelloData;
  invite?: string | null;
  onDone: (p: Profile, secret: string[], invite: string | null) => Promise<void>;
}) {
  const [step, setStep] = useState<JoinStep>("name");
  const [name, setName] = useState("");
  const [face, setFace] = useState(() => hello.faces[Math.floor(Math.random() * hello.faces.length)]);
  const [color, setColor] = useState(() => hello.colors[Math.floor(Math.random() * hello.colors.length)]);
  const [secret, setSecret] = useState<string[]>([]);
  const [wrong, setWrong] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<string | null>(initialInvite);
  const [host, setHost] = useState<Face | null>(null);
  const [asGuest, setAsGuest] = useState(false);
  const [typingCode, setTypingCode] = useState(false);
  const [code, setCode] = useState("");

  // An invite: say who it's from, or that it ran out.
  useEffect(() => {
    if (!invite) return;
    house.inviteInfo(invite).then(
      (i) => (setHost(i.by), setAsGuest(i.role === "guest"), setError(null)),
      () => (setInvite(null), setError("That invite has run out. You can still knock!")),
    );
  }, [invite]);

  const finish = async (again: string[]) => {
    if (again.join("") !== secret.join("")) {
      setWrong((n) => n + 1);
      setError("Those don't match. Make your PIN again?");
      setSecret([]);
      setStep("secret");
      return;
    }
    setBusy(true);
    try {
      await onDone({ name: name.trim(), face, color }, secret, invite);
    } catch (e) {
      cue("error");
      setError(e instanceof Error ? e.message : "Something went wrong. Try again?");
      if (e instanceof house.Oops && e.status === 410) setInvite(null);
      // A name already taken is fixed on the first step.
      setStep(/already|name/i.test(String((e as Error).message)) ? "name" : "secret");
      setSecret([]);
    } finally {
      setBusy(false);
    }
  };

  const me = (
    <div className="face-badge" style={tint(color)} aria-hidden>
      {face}
    </div>
  );

  return (
    <div className="door-center">
      {step === "name" && (
        <form
          className="door-step"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return (cue(["error", { emphasis: "subtle" }]), setError("What's your name?"));
            setError(null);
            setStep("face");
          }}
        >
          {invite && host ? (
            <p className="invited">
              <span className="face-mini" style={tint(host.color)}>{host.face}</span> {host.name} invited you{asGuest ? " as a guest" : ""}!
            </p>
          ) : null}
          <h1 className="door-title">{title}</h1>
          <p className="door-intro">{intro}</p>
          <label className="door-label" htmlFor="join-name">What's your name?</label>
          <input
            id="join-name"
            className="door-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoComplete="given-name"
            autoFocus
          />
          <button className="door-go" type="submit" disabled={!name.trim()}>
            Next
          </button>
          {!invite && !hello.first && (
            typingCode ? (
              <div className="code-row">
                <input
                  className="door-input code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                  placeholder="CODE"
                  aria-label="Invite code"
                  autoCapitalize="characters"
                />
                <button type="button" className="door-small" disabled={code.length !== 6} onClick={() => setInvite(code)}>
                  Use it
                </button>
              </div>
            ) : (
              <button type="button" className="door-link" onClick={() => setTypingCode(true)}>
                Got a code from the panel? 🎟️
              </button>
            )
          )}
        </form>
      )}

      {step === "face" && (
        <div className="door-step">
          {me}
          <h1 className="door-title">Pick your face, {name.trim()}</h1>
          <div className="face-grid" role="radiogroup" aria-label="Face">
            {hello.faces.map((f) => (
              <button key={f} role="radio" aria-checked={f === face} className="face-pick" onClick={() => setFace(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="color-row" role="radiogroup" aria-label="Colour">
            {hello.colors.map((c) => (
              <button key={c} role="radio" aria-checked={c === color} className="color-pick" style={tint(c)} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
          <button className="door-go" onClick={() => setStep("secret")}>
            That's me!
          </button>
        </div>
      )}

      {step === "secret" && (
        <div className="door-step">
          {me}
          <h1 className="door-title">Make a PIN</h1>
          <p className="door-intro">Pick 4 numbers you'll remember. You'll tap them to come back in.</p>
          <Keypad
            key={`make-${wrong}`}
            wrong={wrong}
            keys={hello.keys}
            onDone={(s) => {
              setSecret(s);
              setError(null);
              setStep("again");
            }}
          />
        </div>
      )}

      {step === "again" && (
        <div className="door-step">
          {me}
          <h1 className="door-title">Once more, to be sure</h1>
          <Keypad keys={hello.keys} disabled={busy} onDone={finish} />
        </div>
      )}

      <p className="door-hint" role="status">{error ?? " "}</p>
    </div>
  );
}

/** A short burst of paper confetti. Skipped for people who'd rather things kept still. */
function Confetti() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = ref.current;
    if (!box) return;
    const bits = ["🎉", "✨", "🎈", "⭐", "🌈", "💛"];
    for (let i = 0; i < 28; i++) {
      const el = document.createElement("span");
      el.textContent = bits[i % bits.length];
      el.className = "confetti-bit";
      box.appendChild(el);
      const x = (Math.random() - 0.5) * 2 * Math.min(innerWidth / 2, 420);
      const y = -(200 + Math.random() * 260);
      el.animate(
        [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
          { transform: `translate(${x}px, ${y}px) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${x * 1.15}px, ${y + 420}px) rotate(${(Math.random() - 0.5) * 720}deg)`, opacity: 0 },
        ],
        { duration: 1600 + Math.random() * 700, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards", delay: Math.random() * 120 },
      );
    }
    return () => box.replaceChildren();
  }, []);
  return <div className="confetti" ref={ref} aria-hidden />;
}
