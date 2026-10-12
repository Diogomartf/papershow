import { useEffect, useRef, useState } from "react";

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The live picture, changing the way the panel does: when `src` changes, a full e-ink refresh
 * plays (old picture inverted, black, white, black, new picture inverted, then settled) instead of a cut.
 * The new picture is decoded first, so the flash never lands on a blank frame.
 */
export function EinkImage({ src }: { src: string }) {
  const [shown, setShown] = useState(src);
  const [next, setNext] = useState<string | null>(null);
  // The newest src asked for, in case it changes again mid-refresh.
  const wanted = useRef(src);

  useEffect(() => {
    wanted.current = src;
    if (src === shown || next) return;
    let live = true;
    const img = new Image();
    img.src = src;
    img
      .decode()
      .catch(() => {})
      .then(() => {
        if (!live) return;
        if (reduceMotion()) setShown(src);
        else setNext(src);
      });
    return () => {
      live = false;
    };
  }, [src, shown, next]);

  const settle = () => {
    if (!next) return;
    setShown(next);
    setNext(null);
    // If src moved on during the refresh, the effect picks it up now that `next` is clear.
  };

  return (
    <div className="eink-swap" data-refreshing={!!next}>
      <span className="eink-layer old">
        <img className="live-img" src={shown} alt="" />
      </span>
      {next && (
        <>
          <span className="eink-layer new" onAnimationEnd={(e) => e.animationName === "einkNew" && settle()}>
            <img className="live-img" src={next} alt="" />
          </span>
          <span className="eink-ink" aria-hidden />
        </>
      )}
    </div>
  );
}
