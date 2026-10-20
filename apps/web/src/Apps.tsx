import { useEffect, useMemo, useRef, useState } from "react";
import { Blocks } from "./Blocks";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import * as appsApi from "./apps";
import type { AppInstance, AppKind, Field } from "./apps";
import { addToShow, ask, setLive } from "./slides";
import { mine, reason, tint, useMe } from "./house";
import { useLiveState } from "./live";
import { cue, DONE, type Cue } from "./sound";

/** The form's state, tagged with the app it belongs to so it can never be saved onto another. */
type Draft = { id: string; name: string; config: Record<string, unknown> };
const body = (d: Draft) => JSON.stringify({ name: d.name, config: d.config });

/** Lists show as "a, b, c" while you type; the server splits them. */
const toForm = (fields: Field[], config: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, fields.find((f) => f.key === k)?.type === "list" && Array.isArray(v) ? v.join(", ") : v]),
  );

/** A new app is called by its title. With no title, it keeps the kind's name. */
const nameFor = (kind: AppKind, config: Record<string, unknown>) => {
  const title = typeof config.title === "string" ? config.title.trim() : "";
  return title || kind.name;
};

/** `newKind`: setting up an app that isn't created yet; nothing is saved until "Create app". */
export function Apps({ id, newKind }: { id: string | null; newKind?: string }) {
  // Start from what the page already loaded (at boot, or the last visit), then refresh.
  const [catalog, setCatalog] = useState<AppKind[]>(() => appsApi.cached.catalog ?? []);
  const [apps, setApps] = useState<AppInstance[] | null>(() => appsApi.cached.apps);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Rendering can take a few seconds (prices, names, logos fetched first): say so, and say if it failed.
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The preview as the panel shows it, or the full-resolution render before it's reduced to 1 bit.
  const [view, setView] = useState<"eink" | "original">(() => (localStorage.getItem("apps-view") === "original" ? "original" : "eink"));
  useEffect(() => localStorage.setItem("apps-view", view), [view]);
  const [saved, setSaved] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Apps · Papershow";
    Promise.all([appsApi.getCatalog(), appsApi.listApps()]).then(([c, a]) => {
      setCatalog(c);
      setApps(a);
    });
  }, []);

  // No app in the URL: open the most recent one.
  useEffect(() => {
    if (!id && !newKind && apps?.length) {
      history.replaceState(null, "", `/apps/${apps[0].id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [id, newKind, apps]);

  const current = apps?.find((a) => a.id === id) ?? null;
  const { me } = useMe();
  const everyone = useLiveState().state?.people ?? [];
  const makerOf = (madeBy: string | null) => everyone.find((p) => p.id === madeBy);
  // Anyone can show, add or duplicate an app; only its maker or an admin changes it.
  const canChange = !current || mine(me, current.madeBy);
  // Guests ask before something goes on the panel, and don't add to the show.
  const guest = me.role === "guest";
  const maker = current && makerOf(current.madeBy);
  const kindId = current?.kind ?? newKind;
  const kind = useMemo(() => catalog.find((k) => k.kind === kindId), [catalog, kindId]);
  const isNew = !current && !!newKind && !!kind;
  // Until the live render comes back, the saved app's current frame: the browser has it from the list already.
  const shown = preview ?? (current && view === "eink" ? appsApi.appFrameUrl(current) : null);

  // Load the selected app into the form.
  const lastSaved = useRef("");
  // True once the name field is typed in. Until then a new app's name follows its title.
  const nameEdited = useRef(false);
  useEffect(() => {
    // Another app: don't leave the last one's picture up while this one renders.
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setFailed(false);
    nameEdited.current = false;
    if (current && kind) {
      const d = { id: current.id, name: current.name, config: toForm(kind.fields, current.config) };
      lastSaved.current = body(d);
      setDraft(d);
      setSaved(true);
    } else if (newKind && kind) {
      const config = toForm(kind.fields, kind.defaults);
      setDraft({ id: `new:${kind.kind}`, name: nameFor(kind, config), config });
    } else setDraft(null);
    // Only when switching apps, not on every save echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, newKind, kind]);

  // Preview the draft as you type; clocks also tick while you watch.
  useEffect(() => {
    if (!draft || !kind) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    const run = () => {
      setLoading(true);
      return appsApi.previewApp(kind.kind, draft.config, ctrl.signal, view === "original").then(
        (u) => {
          url = u;
          setPreview((old) => {
            if (old) URL.revokeObjectURL(old);
            return u;
          });
          setLoading(false);
          setFailed(false);
        },
        () => {
          // Aborted: a newer render took over, and it owns the loading state.
          if (ctrl.signal.aborted) return;
          setLoading(false);
          setFailed(true);
        },
      );
    };
    const t = setTimeout(run, 180);
    const tick = kind.periodMs <= 60_000 ? setInterval(run, 15_000) : undefined;
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearInterval(tick);
      void url;
    };
  }, [draft, kind, view]);

  // Save shortly after you stop typing.
  useEffect(() => {
    if (!draft || draft.id !== current?.id || !canChange) return;
    const b = body(draft);
    if (b === lastSaved.current) return;
    setSaved(false);
    const t = setTimeout(async () => {
      const next = await appsApi.updateApp(draft.id, { name: draft.name, config: draft.config });
      lastSaved.current = b;
      setApps((list) => list?.map((a) => (a.id === next.id ? next : a)) ?? null);
      setSaved(true);
    }, 450);
    return () => clearTimeout(t);
  }, [draft, current?.id, canChange]);

  /** A toast, sounding like what it reports: done unless it says otherwise. */
  const flash = (msg: string, sound: Cue | null = DONE) => {
    cue(sound);
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  };

  /** Run `fn`; if the server says no (a limit, say), show why. */
  const tried = (fn: () => Promise<unknown>) => () => fn().catch((e) => flash(reason(e, "That didn't work"), "error"));

  const create = tried(async () => {
    if (!kind || !draft) return;
    const app = await appsApi.createApp(kind.kind, { name: draft.name, config: draft.config });
    setApps((list) => [app, ...(list ?? [])]);
    navigate(`/apps/${app.id}`);
    flash(`Created ${app.name}`);
  });

  /** A copy of this app with the same settings, to tweak from there. */
  const duplicate = tried(async () => {
    if (!current || !kind || !draft) return;
    const app = await appsApi.createApp(kind.kind, { name: `${draft.name} copy`, config: draft.config });
    setApps((list) => [app, ...(list ?? [])]);
    navigate(`/apps/${app.id}`);
    flash(`Duplicated ${draft.name}`);
  });

  const remove = async () => {
    if (!current) return;
    await appsApi.deleteApp(current.id);
    const rest = apps?.filter((a) => a.id !== current.id) ?? [];
    setApps(rest);
    navigate(rest.length ? `/apps/${rest[0].id}` : "/apps");
  };

  const set = (key: string, value: unknown) =>
    setDraft((d) => {
      if (!d || !kind) return d;
      const config = { ...d.config, [key]: value };
      // Left alone, the name stays the title. Typing in the name field keeps whatever you wrote.
      const follow = isNew && key === "title" && !nameEdited.current;
      return { ...d, config, name: follow ? nameFor(kind, config) : d.name };
    });

  return (
    <div className="app apps">
      <header className="bar">
        <div className="bar-left">
          <Nav current="apps" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>

      <main className="apps-main">
        <aside className="rail">
          <h2>House apps</h2>
          <ul className="rail-list">
            {apps?.map((a) => (
              <li key={a.id}>
                <a
                  href={`/apps/${a.id}`}
                  aria-current={a.id === id ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/apps/${a.id}`);
                  }}
                >
                  <img src={appsApi.appFrameUrl(a)} alt="" />
                  <span>
                    <strong>{a.id === id && draft ? draft.name : a.name}</strong>
                    <small>{catalog.find((k) => k.kind === a.kind)?.name}</small>
                  </span>
                  {makerOf(a.madeBy) && (
                    <span className="face-mini maker" style={tint(makerOf(a.madeBy)!.color)} title={`By ${makerOf(a.madeBy)!.name}`}>
                      {makerOf(a.madeBy)!.face}
                    </span>
                  )}
                </a>
              </li>
            ))}
            {apps?.length === 0 && <li className="muted rail-empty">None yet. Pick one below.</li>}
          </ul>

          <h2>New app</h2>
          {appsApi.CATEGORIES.map((cat) => {
            const kinds = catalog.filter((k) => k.category === cat.id);
            return kinds.length ? (
              <section key={cat.id} className="kind-group">
                <h3>{cat.label}</h3>
                <ul className="kinds">
                  {kinds.map((k) => (
                    <li key={k.kind}>
                      <button onClick={() => navigate(`/apps/new/${k.kind}`)} aria-current={newKind === k.kind ? "true" : undefined}>
                        <strong>{k.name}</strong>
                        <small>{k.description}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null;
          })}
        </aside>

        <section className="app-stage">
          <div className="device small">
            <div className="panel">
              {shown && (current || isNew) ? (
                <img className="live-img" data-view={view} data-quiet={saved && !isNew} key={shown} src={shown} alt="" />
              ) : (
                <p className="panel-empty">{apps?.length === 0 ? "Pick an app on the left to set it up." : ""}</p>
              )}
              {/* Nothing to say while it only re-renders what the saved frame already shows. */}
              {(current || isNew) && loading && (!shown || !saved) && (
                <div className="panel-loading" data-over={!!shown} role="status">
                  <Blocks size={shown ? 5 : 18} />
                  <span>{shown ? "Updating…" : `Loading ${kind?.name ?? "app"}…`}</span>
                </div>
              )}
              {(current || isNew) && failed && !loading && (
                <div className="panel-loading failed" role="alert">
                  Couldn’t load {kind?.name ?? "this app"}. Its data source may be down; it will try again as you change settings.
                </div>
              )}
            </div>
            <span className="ribbon" aria-hidden />
          </div>
          <div className="shelf thin" aria-hidden />
          {(current || isNew) && (
            <div className="segmented view-switch" role="radiogroup" aria-label="Preview">
              <button role="radio" aria-checked={view === "eink"} onClick={() => setView("eink")}>E-ink</button>
              <button role="radio" aria-checked={view === "original"} onClick={() => setView("original")}>Original</button>
            </div>
          )}
        </section>

        <aside className="settings">
          {(current || isNew) && kind && draft ? (
            <>
              <div className="settings-head">
                <input
                  className="name"
                  value={draft.name}
                  onChange={(e) => {
                    nameEdited.current = true;
                    setDraft({ ...draft, name: e.target.value });
                  }}
                  readOnly={!canChange}
                  aria-label="App name"
                  spellCheck={false}
                />
                <span className="saved" data-on={saved}>{isNew ? "Not created yet" : !canChange ? "" : saved ? "Saved" : "Saving…"}</span>
              </div>
              <p className="muted kind-line">
                {kind.name}
                <span aria-hidden>·</span>
                <span>from {kind.source}</span>
                {kind.mock && <span className="chip">Mock data</span>}
              </p>

              {!canChange && (
                <p className="made-by">
                  {maker && <span className="face-mini" style={tint(maker.color)} aria-hidden>{maker.face}</span>}
                  <span>
                    {maker?.name ?? "Someone"} made this, so only they or an admin can change it. Duplicate it to make your own.
                  </span>
                </p>
              )}

              <fieldset className="plain" disabled={!canChange}>
                {kind.fields.map((f) => (
                  <FieldInput key={f.key} field={f} value={draft.config[f.key]} onChange={(v) => set(f.key, v)} />
                ))}
              </fieldset>

              {isNew ? (
                <div className="settings-actions">
                  <button className="primary" onClick={create}>Create app</button>
                  <button className="ghost" onClick={() => navigate("/apps")}>Cancel</button>
                </div>
              ) : (
                <div className="settings-actions">
                  {guest ? (
                    <button
                      className="primary"
                      onClick={tried(async () => {
                        await ask({ kind: "app", id: current!.id });
                        flash(`Asked to show ${draft.name} 🙋`);
                      })}
                    >
                      Ask to show
                    </button>
                  ) : (
                    <>
                      <button
                        className="primary"
                        onClick={tried(async () => {
                          await setLive({ mode: "pin", source: { kind: "app", id: current!.id } });
                          flash(`${draft.name} is on /live for 15 minutes`, null);
                        })}
                      >
                        Show now
                      </button>
                      <button
                        className="ghost"
                        onClick={tried(async () => {
                          await addToShow({ source: { kind: "app", id: current!.id } });
                          flash(`Added ${draft.name} to the show`);
                        })}
                      >
                        Add to show
                      </button>
                    </>
                  )}
                  <button className="ghost" onClick={duplicate}>Duplicate</button>
                  {canChange && <button className="ghost danger" onClick={remove}>Delete</button>}
                </div>
              )}
            </>
          ) : (
            apps && <p className="muted">Set up an app to see its settings here.</p>
          )}
        </aside>
      </main>

      <div className="toast" data-on={!!toast} role="status">{toast}</div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const id = `f-${field.key}`;
  return (
    <div className="setting">
      <label htmlFor={id}>{field.label}</label>
      {field.type === "toggle" ? (
        <button id={id} className="toggle" role="switch" aria-checked={!!value} onClick={() => onChange(!value)}>
          <span />
        </button>
      ) : field.type === "select" ? (
        <div className="segmented" role="radiogroup" id={id}>
          {field.options.map((o) => (
            <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : field.type === "textarea" ? (
        <textarea
          id={id}
          className="text"
          rows={5}
          value={String(value ?? "")}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      ) : field.type === "picks" ? (
        <Picks id={id} field={field} value={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />
      ) : (
        <input
          id={id}
          className="text"
          value={String(value ?? "")}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      {field.hint && <small className="muted">{field.hint}</small>}
    </div>
  );
}

/** Tap to add or remove; the order you pick in is the order they show. Full once `max` are picked. */
function Picks({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: Extract<Field, { type: "picks" }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const full = field.max !== undefined && value.length >= field.max;
  return (
    <div className="picks" id={id} role="group">
      {field.options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
          >
            {on && <span className="pick-n">{value.indexOf(o.value) + 1}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
