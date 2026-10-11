import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Slides } from "./Slides.tsx";
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
  if (path.startsWith("/slides")) return <Slides />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
