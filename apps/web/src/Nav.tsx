import type { MouseEvent } from "react";

/** Client-side navigation: swap the route without a reload. */
export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

const go = (to: string) => (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a tab
  e.preventDefault();
  navigate(to);
};

export function Nav({ current }: { current: "draw" | "show" }) {
  return (
    <nav className="nav">
      <span className="mark" aria-hidden />
      <a href="/" aria-current={current === "draw" ? "page" : undefined} onClick={go("/")}>ImageGen</a>
      <a href="/slides" aria-current={current === "show" ? "page" : undefined} onClick={go("/slides")}>SlideGen</a>
    </nav>
  );
}
