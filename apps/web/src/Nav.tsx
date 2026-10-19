import type { MouseEvent } from "react";
import { useMe } from "./house";

/** Client-side navigation: swap the route without a reload. */
export function navigate(to: string) {
  // Marks the entry as reached from inside Papershow, so a page's Back can step back to it.
  history.pushState({ from: location.pathname }, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

const go = (to: string) => (e: MouseEvent) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a tab
  e.preventDefault();
  navigate(to);
};

const SECTIONS = [
  { id: "dashboard", href: "/", label: "Dashboard" },
  { id: "show", href: "/show", label: "Show" },
  { id: "apps", href: "/apps", label: "Apps" },
  { id: "draw", href: "/draw", label: "Draw" },
] as const;

export type Section = (typeof SECTIONS)[number]["id"] | "people" | "log";

export function Nav({ current }: { current: Section }) {
  // Guests don't run the show, so they don't get its page.
  const guest = useMe().me.role === "guest";
  return (
    <nav className="nav">
      <img className="mark" src="/icon-nav.png" alt="" />
      <span className="wordmark" role="img" aria-label="Papershow" />
      {SECTIONS.filter((s) => !(guest && s.id === "show")).map((s) => (
        <a key={s.id} href={s.href} aria-current={current === s.id ? "page" : undefined} onClick={go(s.href)}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}
