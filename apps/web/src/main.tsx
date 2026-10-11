import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Viewer } from "./Viewer.tsx";

const viewing = location.pathname.match(/^\/i\/([\w-]+)/);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{viewing ? <Viewer id={viewing[1]} /> : <App />}</StrictMode>,
);
