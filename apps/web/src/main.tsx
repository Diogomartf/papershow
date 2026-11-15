import { lazy, StrictMode, Suspense, startTransition, useCallback, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { booting, loadEverything } from "./boot.ts";
import { Dashboard } from "./Dashboard.tsx";
import { Hello } from "./Hello.tsx";
import { navigate } from "./Nav.tsx";
import { People } from "./People.tsx";
import { hello as getHello, Me, SIGNED_OUT, signOut, useMe, visiting, type Hello as HelloData } from "./house";
import { cue, startSound } from "./sound.ts";

// Each page is its own bundle, so the first page opened starts sooner and an update only re-downloads the pages
// that changed. The Dashboard (where most visits land), the front door and People (the Dashboard shows its log)
// stay in the main one.
const pages: (() => Promise<unknown>)[] = [];
/** A page loaded on demand, from `load`, a module whose `name` export is the page. */
function page<P>(load: () => Promise<Record<string, unknown>>, name: string) {
  pages.push(load);
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType<P> })));
}
const App = page<object>(() => import("./App.tsx"), "default");
const Apps = page<{ id: string | null; newKind?: string }>(() => import("./Apps.tsx"), "Apps");
const Log = page<object>(() => import("./Log.tsx"), "Log");
const Manage = page<object>(() => import("./Manage.tsx"), "Manage");
const Pi = page<object>(() => import("./Pi.tsx"), "Pi");
const Photos = page<{ id: string | null }>(() => import("./Photos.tsx"), "Photos");
const Party = page<object>(() => import("./Party.tsx"), "Party");
const PartyStory = page<{ id: string }>(() => import("./Party.tsx"), "PartyStory");
const Playlist = page<{ id: string | null }>(() => import("./Playlist.tsx"), "Playlist");
const Show = page<object>(() => import("./Show.tsx"), "Show");
const Viewer = page<{ id: string }>(() => import("./Viewer.tsx"), "Viewer");

/**
 * Fetch every page's bundle once the first page is up and the browser is idle, so moving to another page
 * doesn't wait on the network. The browser keeps them, so this costs nothing on later visits.
 */
function preloadPages() {
  const all = () => pages.forEach((load) => load().catch(() => {}));
  if ("requestIdleCallback" in window) requestIdleCallback(all, { timeout: 3000 });
  else setTimeout(all, 1500);
}

function Router() {
  const [path, setPath] = useState(location.pathname);
  const { me } = useMe();
  const guest = visiting(me);
  // Only once someone's in: the front door shouldn't spend the network on pages it can't open.
  useEffect(preloadPages, []);
  useEffect(() => {
    // A transition: while the next page's bundle loads, the current page stays up instead of going blank.
    const onPop = () => startTransition(() => setPath(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // Already in: an invite link just opens Papershow.
  useEffect(() => {
    if (path.startsWith("/join/")) navigate("/");
  }, [path]);

  // The show, the playlists, the log and the Pi page are the household's: a guest lands on the Dashboard. A party guest is at
  // the party and nowhere else: the Party page, drawing for it, and their own profile.
  const partyGuest = me.role === "party";
  const offLimits = partyGuest ? !/^\/(party|parties|draw|people)\b/.test(path) || path.startsWith("/people/manage") : guest && /^\/(show|library|playlists?|slides|log|pi)\b/.test(path);
  const home = partyGuest ? "/party" : "/";
  useEffect(() => {
    if (offLimits) history.replaceState(null, "", home);
  }, [offLimits, home]);
  if (offLimits) return partyGuest ? <Party /> : <Dashboard />;

  const story = path.match(/^\/parties\/([\w-]+)/);
  if (story) return <PartyStory id={story[1]} />;
  if (path.startsWith("/part")) return <Party />;

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
  if (path === "/pi" || path.startsWith("/pi/")) return <Pi />;
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
      <Suspense fallback={null}>
        <Router />
      </Suspense>
    </Me.Provider>
  );
}

// A tab left open across an update asks for page bundles that are gone (their names change with each build):
// load the new version instead of showing a blank page. Once a minute at most, in case the server is the problem.
addEventListener("vite:preloadError", (e) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem("reloaded-for-update") ?? 0) < 60_000) return;
    sessionStorage.setItem("reloaded-for-update", String(Date.now()));
  } catch {
    // Without storage, still reload: a blank page is worse than an extra reload.
  }
  e.preventDefault();
  location.reload();
});

startSound();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
