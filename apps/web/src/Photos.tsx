import { useEffect, useRef, useState } from "react";
import { PANEL, PHOTO_FILL, photoFit, type PhotoAt, type Scene } from "@papershow/scene";
import { LightSwitch } from "./LightSwitch";
import { LiveLink } from "./LiveLink";
import { MeMenu } from "./MeMenu";
import { Nav, navigate } from "./Nav";
import { PhotoLayer } from "./PhotoLayer";
import { paintMono, renderScene } from "./render";
import { addToShow, ask, setLive } from "./slides";
import { loadItems } from "./sources";
import { deleteImage, fileUrl, getImage, listImages, putImage, type ImageMeta } from "./store";
import { mine, reason, tint, useMe } from "./house";
import { useLiveState } from "./live";
import { shortId } from "./id";
import { cue, DONE, type Cue } from "./sound";
import { useUploads } from "./Uploads";

/** What a save would change: the name and the framing. */
const savedKey = (s: Scene) => JSON.stringify([s.name, s.photoAt ?? PHOTO_FILL]);

const isPhoto = (i: ImageMeta) => i.kind === "photo";

/** /photos: the house's photos, ready for the panel, a Photos app, or to draw on. Each one is framed here. */
export function Photos({ id }: { id: string | null }) {
  const [photos, setPhotos] = useState<ImageMeta[] | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<"photo" | "eink">("photo");
  const [saved, setSaved] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Delete takes a second press: the photo also leaves every playlist and the show.
  const [deleting, setDeleting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const lastSaved = useRef("");
  const { me } = useMe();
  const guest = me.role === "guest";
  const everyone = useLiveState().state?.people ?? [];
  const makerOf = (madeBy: string | null | undefined) => everyone.find((p) => p.id === madeBy);

  useEffect(() => {
    document.title = "Photos · Papershow";
    listImages().then((xs) => setPhotos(xs.filter(isPhoto)), () => setPhotos([]));
  }, []);

  // No photo in the URL: open the newest.
  useEffect(() => {
    if (!id && photos?.length) {
      history.replaceState(null, "", `/photos/${photos[0].id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [id, photos]);

  const meta = photos?.find((p) => p.id === id) ?? null;
  const canChange = !!meta && mine(me, meta.madeBy);
  const maker = makerOf(meta?.madeBy);

  // Open the picked photo, as saved.
  useEffect(() => {
    setScene(null);
    setNatural(null);
    setDeleting(false);
    if (!id) return;
    let gone = false;
    getImage(id).then(
      ({ scene: s }) => {
        if (gone) return;
        lastSaved.current = savedKey(s);
        setSaved(true);
        setScene(s);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [id]);

  // Its size, for Whole: the scale at which all of it fits depends on its shape.
  useEffect(() => {
    if (!scene?.photo) return;
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = scene.photo;
  }, [scene?.photo]);

  // The e-ink view: the photo as the panel will show it.
  useEffect(() => {
    if (scene && view === "eink" && preview.current) paintMono(scene, preview.current);
  }, [scene, view]);

  // Save shortly after the framing or the name stops changing. The panel's frame is rendered here, as Draw does.
  useEffect(() => {
    if (!scene || scene.id !== id || !canChange) return;
    const key = savedKey(scene);
    if (key === lastSaved.current) return;
    setSaved(false);
    const t = setTimeout(async () => {
      try {
        const next = { ...scene, updatedAt: Date.now() };
        const m = await putImage(next, await renderScene(next), "photo");
        lastSaved.current = key;
        setPhotos((xs) => xs?.map((x) => (x.id === m.id ? m : x)) ?? null);
        setSaved(true);
      } catch (err) {
        flash(reason(err, "Couldn't save the framing. Try again"), "error");
      }
    }, 500);
    return () => clearTimeout(t);
    // flash only shows a toast; it doesn't need to restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, id, canChange]);

  /** A toast, sounding like what it reports: done unless it says otherwise. */
  const flash = (msg: string, sound: Cue | null = DONE) => {
    cue(sound);
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400);
  };

  /** Run `fn`; if the server says no (a limit, say), show why. */
  const tried = (fn: () => Promise<unknown>) => () => fn().catch((e) => flash(reason(e, "That didn't work"), "error"));

  /** Add pictures to the library, each filling the panel to start with. The first one opens as soon as it's in. */
  const uploads = useUploads({
    send: (s, files, onSent) => putImage(s, files, "photo", onSent),
    added: (m, n) => {
      setPhotos((xs) => [m, ...(xs ?? [])]);
      if (n === 1) navigate(`/photos/${m.id}`);
    },
    finished: (added, failed) => {
      if (added) void loadItems().catch(() => {});
      if (failed) flash(`${added ? `Added ${added}, but` : "Sorry:"} ${failed === 1 ? "one didn't" : `${failed} didn't`} go in`, "error");
      else if (added) flash(added === 1 ? "Added a photo" : `Added ${added} photos`);
    },
  });
  const add = uploads.add;

  /**
   * The same picture as a photo of its own, framed as it is now, to frame another way: a close crop and the whole
   * thing, say. Named after this one with the next free number.
   */
  const saveVersion = tried(async () => {
    if (!scene) return;
    const base = scene.name.replace(/ \d+$/, "");
    const taken = new Set(photos?.map((p) => p.name));
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    const now = Date.now();
    const copy: Scene = { ...scene, id: shortId(), name: `${base} ${n}`, createdAt: now, updatedAt: now };
    const m = await putImage(copy, await renderScene(copy), "photo");
    setPhotos((xs) => [m, ...(xs ?? [])]);
    void loadItems().catch(() => {});
    navigate(`/photos/${m.id}`);
    flash(`Saved ${m.name}: frame it however you like`);
  });

  const remove = tried(async () => {
    if (!meta) return;
    await deleteImage(meta.id);
    const rest = photos?.filter((p) => p.id !== meta.id) ?? [];
    setPhotos(rest);
    void loadItems().catch(() => {});
    navigate(rest.length ? `/photos/${rest[0].id}` : "/photos");
    flash(`Deleted ${meta.name}`);
  });

  const at = scene?.photoAt ?? PHOTO_FILL;
  const frame = (next: PhotoAt) => setScene((s) => (s ? { ...s, photoAt: next } : s));
  const fit = natural ? photoFit(natural.w, natural.h, at.angle) : 1;
  const centre = { x: PANEL.w / 2, y: PANEL.h / 2 };
  const filled = at.scale === 1 && at.x === centre.x && at.y === centre.y;
  const whole = Math.abs(at.scale - fit) < 0.01 && at.x === centre.x && at.y === centre.y;

  // Files dropped anywhere on the page are added.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      setDragging(false);
      add([...e.dataTransfer.files]);
    },
  };

  const addButton = (
    <button className="primary" onClick={() => input.current?.click()}>
      {uploads.busy ? "Add more" : "Add photos"}
    </button>
  );

  return (
    <div className="app apps photos" data-dragging={dragging} {...dropProps}>
      <header className="bar">
        <div className="bar-left">
          <Nav current="photos" />
        </div>
        <div />
        <div className="bar-right">
          <LightSwitch />
          <LiveLink />
          <MeMenu />
        </div>
      </header>

      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />

      <main className="apps-main">
        <aside className="rail">
          <div className="photos-add">{addButton}</div>
          {uploads.node}
          <h2>Photos</h2>
          {photos?.length === 0 ? (
            <p className="muted rail-empty">None yet. Add some, or drop them anywhere on this page.</p>
          ) : (
            <ul className="photo-grid">
              {photos?.map((p) => (
                <li key={p.id}>
                  <a
                    href={`/photos/${p.id}`}
                    aria-current={p.id === id ? "page" : undefined}
                    aria-label={p.name}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/photos/${p.id}`);
                    }}
                  >
                    <img src={fileUrl(p, "png")} alt="" loading="lazy" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="app-stage">
          <div className="device small">
            <div className="panel photo-panel">
              {scene?.photo ? (
                <>
                  <PhotoLayer photo={scene.photo} at={at} onChange={frame} active={canChange} hidden={view === "eink"} />
                  <canvas ref={preview} className="eink" data-on={view === "eink"} aria-hidden />
                </>
              ) : photos?.length === 0 ? (
                <div className="photos-empty">
                  <strong>Your photos, ready for the panel</strong>
                  <span>Add a few, frame each one, then put them on the panel, in a Photos app, or draw on them.</span>
                  {addButton}
                </div>
              ) : null}
            </div>
            <span className="ribbon" aria-hidden />
          </div>
          <div className="shelf thin" aria-hidden />
          {scene && (
            <div className="segmented view-switch" role="radiogroup" aria-label="Preview">
              <button role="radio" aria-checked={view === "photo"} onClick={() => setView("photo")}>Photo</button>
              <button role="radio" aria-checked={view === "eink"} onClick={() => setView("eink")}>E-ink</button>
            </div>
          )}
        </section>

        <aside className="settings">
          {meta && scene ? (
            <>
              <div className="settings-head">
                <input
                  className="name"
                  value={scene.name}
                  onChange={(e) => setScene({ ...scene, name: e.target.value })}
                  readOnly={!canChange}
                  aria-label="Photo name"
                  spellCheck={false}
                />
                <span className="saved" data-on={saved}>{!canChange ? "" : saved ? "Saved" : "Saving…"}</span>
              </div>
              {(meta.takenAt || meta.place) && (
                <p className="muted kind-line">
                  Taken
                  {meta.takenAt && ` ${new Date(meta.takenAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`}
                  {meta.place && ` in ${meta.place}`}
                </p>
              )}

              {!canChange && (
                <p className="made-by">
                  {maker && <span className="face-mini" style={tint(maker.color)} aria-hidden>{maker.face}</span>}
                  <span>{maker?.name ?? "Someone"} added this, so only they or an admin can frame it. You can still show it or draw on it.</span>
                </p>
              )}

              {canChange && (
                <div className="setting">
                  <label>Framing</label>
                  <div className="segmented" role="group">
                    <button aria-pressed={filled} onClick={() => frame({ ...at, ...centre, scale: 1 })}>Fill</button>
                    <button aria-pressed={whole} onClick={() => frame({ ...at, ...centre, scale: fit })}>Whole</button>
                    <button
                      onClick={() => {
                        const angle = (Math.round(at.angle / 90) * 90 + 90) % 360;
                        // Whole stays whole: on its side the photo fits the panel at another scale.
                        const scale = whole && natural ? photoFit(natural.w, natural.h, angle) : at.scale;
                        frame({ ...at, angle, scale });
                      }}
                    >
                      Turn ↻
                    </button>
                  </div>
                  <small className="muted">
                    Drag the photo to move it. Pinch, scroll or pull a corner to crop in or show more; drag just outside a corner to turn it.
                    Fill covers the panel edge to edge; Whole shows all of it, with paper around.
                  </small>
                </div>
              )}

              <div className="settings-actions">
                {guest ? (
                  <button
                    className="primary"
                    onClick={tried(async () => {
                      await ask({ kind: "image", id: meta.id });
                      flash(`Asked to show ${scene.name} 🙋`);
                    })}
                  >
                    Ask to show
                  </button>
                ) : (
                  <>
                    <button
                      className="primary"
                      onClick={tried(async () => {
                        await setLive({ mode: "pin", source: { kind: "image", id: meta.id } });
                        flash(`${scene.name} is on /live for 15 minutes`, null);
                      })}
                    >
                      Show now
                    </button>
                    <button
                      className="ghost"
                      onClick={tried(async () => {
                        await addToShow({ source: { kind: "image", id: meta.id } });
                        flash(`Added ${scene.name} to the show`);
                      })}
                    >
                      Add to show
                    </button>
                  </>
                )}
                <button className="ghost" onClick={() => navigate(`/draw?photo=${encodeURIComponent(meta.id)}`)} title="Start a drawing on this photo">
                  Draw on it
                </button>
                <button className="ghost" onClick={saveVersion} title="Keep this framing as a photo of its own, to frame another way">
                  Save as version
                </button>
                {canChange && !deleting && <button className="ghost danger" onClick={() => setDeleting(true)}>Delete</button>}
              </div>
              {deleting && (
                <div className="manage-confirm">
                  <span>Delete {scene.name}? It comes out of every playlist and the show too. This can't be undone.</span>
                  <button className="ghost" onClick={() => setDeleting(false)}>Keep</button>
                  <button className="danger-solid" onClick={remove}>Delete photo</button>
                </div>
              )}
              <p className="muted photos-tip">
                To show several in turn, or one at random, make a <a href="/apps/new/photos" onClick={(e) => (e.preventDefault(), navigate("/apps/new/photos"))}>Photos app</a>.
              </p>
            </>
          ) : (
            photos && photos.length > 0 && <p className="muted">Pick a photo to frame it.</p>
          )}
        </aside>
      </main>

      <div className="photos-drop" aria-hidden>Drop to add them to Photos</div>
      <div className="toast" data-on={!!toast} role="status">{toast}</div>
    </div>
  );
}
