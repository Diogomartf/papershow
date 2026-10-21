import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Apps } from "./Apps.tsx";
import { booting, loadEverything } from "./boot.ts";
import { Dashboard } from "./Dashboard.tsx";
import { Hello } from "./Hello.tsx";
import { Log } from "./Log.tsx";
import { Manage } from "./Manage.tsx";
import { navigate } from "./Nav.tsx";
import { People } from "./People.tsx";
import { Photos } from "./Photos.tsx";
import { hello as getHello, Me, SIGNED_OUT, signOut, useMe, type Hello as HelloData } from "./house";
import { Playlist } from "./Playlist.tsx";
import { Show } from "./Show.tsx";
import { cue, startSound } from "./sound.ts";
import { Viewer } from "./Viewer.tsx";

function Router() {
  const [path, setPath] = useState(location.pathname);
  const guest = useMe().me.role === "guest";
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // Already in: an invite link just opens Papershow.
  useEffect(() => {
    if (path.startsWith("/join/")) navigate("/");
  }, [path]);

  // The show, the playlists and the log are the household's: a guest lands on the Dashboard.
  const offLimits = guest && /^\/(show|library|playlists?|slides|log)\b/.test(path);
  useEffect(() => {
    if (offLimits) history.replaceState(null, "", "/");
  }, [offLimits]);
  if (offLimits) return <Dashboard />;

  const viewing = path.match(/^\/i\/([\w-]+)/);
  if (viewing) return <Viewer id={viewing[1]} />;
  // /show is what runs; /playlist/:id is one playlist. Older paths still land somewhere sensible.
  const pl = path.match(/^\/(?:show|library|playlists?|slides)(?:\/([\w-]+))?/);
  if (pl) return pl[1] ? <Playlist id={pl[1]} /> : <Show />;
  const fresh = path.match(/^\/apps\/new\/([\w-]+)/);
  if (fresh) return <Apps id={null} newKind={fresh[1]} />;
  const app = path.match(/^\/apps(?:\/([\w-]+))?/);
  if (app) return <Apps id={app[1] ?? null} />;
  const photo = path.match(/^\/photos(?:\/([\w-]+))?/);
  if (photo) return <Photos id={photo[1] ?? null} />;
  if (path.startsWith("/draw")) return <App />;
  if (path.startsWith("/people/manage")) return <Manage />;
  if (path.startsWith("/people")) return <People />;
  if (path.startsWith("/log")) return <Log />;
  return <Dashboard />;
}

/** Nothing but the front door until this device is signed in as someone who's in. */
function Gate() {
  const [hello, setHello] = useState<HelloData | null>(null);
  const refresh = useCallback(function load() {
    getHello().then(setHello, () => setTimeout(load, 3000));
  }, []);

  useEffect(() => {
    booting.then(setHello, refresh);
    addEventListener(SIGNED_OUT, refresh);
    return () => removeEventListener(SIGNED_OUT, refresh);
  }, [refresh]);

  /** Switching profiles: the front door opens on this person's PIN. */
  const [startAs, setStartAs] = useState<string | null>(null);
  const switchTo = useCallback(
    async (id: string) => {
      await signOut().catch(() => {});
      setStartAs(id);
      navigate("/");
      refresh();
    },
    [refresh],
  );

  /** Just signed in: fetch the house before showing it, so it appears whole. */
  const enter = useCallback(async (h: HelloData) => {
    cue("success");
    await loadEverything().catch(() => {});
    setHello(h);
  }, []);

  if (!hello) return null;
  if (hello.me?.status !== "in") {
    const join = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
    return (
      <Hello
        key={`${hello.me?.id ?? "nobody"}:${startAs}`}
        hello={hello}
        joinCode={join?.[1].toUpperCase() ?? null}
        startAs={startAs}
        onIn={(h) => (setStartAs(null), enter(h))}
      />
    );
  }
  return (
    <Me.Provider value={{ me: hello.me, hello, refresh, switchTo }}>
      <Router />
    </Me.Provider>
  );
}

startSound();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
