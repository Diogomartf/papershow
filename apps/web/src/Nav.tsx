import type { CSSProperties, MouseEvent } from "react";
import { useLiveState } from "./live";
import { useMe } from "./house";

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

const SECTIONS = [
  { id: "dashboard", href: "/", label: "Dashboard" },
  { id: "show", href: "/show", label: "Show" },
  { id: "apps", href: "/apps", label: "Apps" },
  { id: "draw", href: "/draw", label: "Draw" },
] as const;

export type Section = (typeof SECTIONS)[number]["id"] | "people" | "log";

export function Nav({ current }: { current: Section }) {
  const { me } = useMe();
  const { state } = useLiveState();
  // Admins see a badge while someone's at the door.
  const knocking = me.role === "admin" ? (state?.people.filter((p) => p.status === "knocking").length ?? 0) : 0;
  const face = state?.me ?? me;
  return (
    <nav className="nav">
      <img className="mark" src="/icon-nav.png" alt="" />
      <span className="wordmark" role="img" aria-label="Papershow" />
      {SECTIONS.map((s) => (
        <a key={s.id} href={s.href} aria-current={current === s.id ? "page" : undefined} onClick={go(s.href)}>
          {s.label}
        </a>
      ))}
      <a
        className="me-chip"
        href="/people"
        aria-current={current === "people" ? "page" : undefined}
        onClick={go("/people")}
        style={{ ["--tile" as string]: face.color } as CSSProperties}
        aria-label={knocking ? `${face.name}: ${knocking} knocking` : `${face.name} and the house`}
        title={face.name}
      >
        <span aria-hidden>{face.face}</span>
        {knocking > 0 && <span className="knock-badge">{knocking}</span>}
      </a>
    </nav>
  );
}
