import { useEffect, type ReactNode } from "react";
import { cue } from "./sound";

/** A playlist's first few pictures as a little pile. It fans out on hover, so you can see what else is in it. */
export function Deck({ thumbs }: { thumbs: string[] }) {
  const cards = thumbs.slice(0, 3);
  if (!cards.length) return <span>Empty</span>;
  return (
    <span className="pg-deck" data-n={cards.length}>
      {cards.map((t, i) => <img key={i} src={t} alt="" data-i={i} />).reverse()}
    </span>
  );
}

/** A bottom sheet on phones, a card in the middle on bigger screens. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && (cue("close"), onClose());
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="pg-scrim" data-cuelume-close onClick={onClose}>
      <div className="pg-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="pg-sheet-head">
          <h2>{title}</h2>
          <button className="pg-close" data-cuelume-close onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
