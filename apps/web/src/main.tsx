import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Apps } from "./Apps.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { Playlist } from "./Playlist.tsx";
import { Show } from "./Show.tsx";
import { Viewer } from "./Viewer.tsx";

function Router() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const viewing = path.match(/^\/i\/([\w-]+)/);
  if (viewing) return <Viewer id={viewing[1]} />;
  // /show is what runs; /playlist/:id is one playlist. Older paths still land somewhere sensible.
  const pl = path.match(/^\/(?:show|library|playlists?|slides)(?:\/([\w-]+))?/);
  if (pl) return pl[1] ? <Playlist id={pl[1]} /> : <Show />;
  const fresh = path.match(/^\/apps\/new\/([\w-]+)/);
  if (fresh) return <Apps id={null} newKind={fresh[1]} />;
  const app = path.match(/^\/apps(?:\/([\w-]+))?/);
  if (app) return <Apps id={app[1] ?? null} />;
  if (path.startsWith("/draw")) return <App />;
  return <Dashboard />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
