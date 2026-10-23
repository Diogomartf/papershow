import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Scene } from "@papershow/scene";
import { Oops, reason } from "./house";
import { cantOpen, photoScene, renderScene } from "./render";

type Files = { png: Blob; mono: Blob; bin: Blob };
type Ready = { scene: Scene; files: Files };

/** One picture on its way: read and rendered here, then sent. */
export type Upload = {
  key: number;
  name: string;
  state: "waiting" | "preparing" | "sending" | "done" | "failed" | "skipped";
  /** How much of it has gone up, 0 to 1. */
  sent: number;
  /** The panel's frame, once it's rendered: what it will look like. */
  thumb?: string;
  why?: string;
};

type Item = Upload & { file: File; ready?: Promise<Ready> };

/** How far along one picture is: reading it is a small share of the work, sending it the rest. */
const share = (u: Upload) =>
  u.state === "done" || u.state === "failed" || u.state === "skipped" ? 1 : u.state === "sending" ? 0.15 + 0.85 * u.sent : u.state === "preparing" ? 0.05 : 0;

const prepare = async (file: File): Promise<Ready> => {
  const scene = await photoScene(file);
  return { scene, files: await renderScene(scene) };
};

const leaving = (e: BeforeUnloadEvent) => e.preventDefault();

/**
 * Pictures from this device, sent one after another in the order picked. The next one is read and rendered while
 * this one goes up, so the browser's work and the network's overlap. More can be added while it's going, Stop
 * leaves the rest, and what didn't go in is listed together at the end instead of a toast each.
 */
export function useUploads<T>(opts: {
  send: (scene: Scene, files: Files, onSent: (f: number) => void) => Promise<T>;
  /** One is in; `n` counts them in this run, so 1 is the first. */
  added: (result: T, n: number) => void;
  finished: (added: number, failed: number) => void;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const queue = useRef<Item[]>([]);
  const running = useRef(false);
  const stopped = useRef<string | null>(null);
  const alive = useRef(true);
  const nextKey = useRef(0);
  const cb = useRef(opts);
  useLayoutEffect(() => {
    cb.current = opts;
  });

  // Leaving the page doesn't stop what's going up, but nothing here is told about it any more.
  useEffect(
    () => () => {
      alive.current = false;
      for (const u of queue.current) if (u.thumb) URL.revokeObjectURL(u.thumb);
    },
    [],
  );

  const sync = () => {
    if (alive.current) setUploads(queue.current.map(({ key, name, state, sent, thumb, why }) => ({ key, name, state, sent, thumb, why })));
  };

  const ahead = (it: Item | undefined) => {
    if (!it || it.ready) return;
    it.ready = prepare(it.file);
    // Its failure is reported when its turn comes.
    it.ready.catch(() => {});
  };

  const run = async () => {
    running.current = true;
    stopped.current = null;
    addEventListener("beforeunload", leaving);
    let added = 0;
    let failed = 0;
    for (let i = 0; i < queue.current.length; i++) {
      const it = queue.current[i];
      if (it.state !== "waiting") continue;
      if (stopped.current !== null) {
        it.state = "skipped";
        it.why = stopped.current;
        continue;
      }
      it.state = "preparing";
      sync();
      try {
        ahead(it);
        const { scene, files } = await it.ready!;
        it.thumb = URL.createObjectURL(files.png);
        it.state = "sending";
        sync();
        ahead(queue.current[i + 1]);
        const result = await cb.current.send(scene, files, (f) => {
          it.sent = f;
          sync();
        });
        it.state = "done";
        added++;
        if (alive.current) cb.current.added(result, added);
      } catch (err) {
        console.error(err);
        it.state = "failed";
        it.why = reason(err, cantOpen(it.file));
        failed++;
        // Past the hour's allowance the rest would fail the same way.
        if (err instanceof Oops && err.status === 429) stopped.current = it.why;
      }
      it.ready = undefined;
      sync();
    }
    removeEventListener("beforeunload", leaving);
    running.current = false;
    // All in: nothing to say beyond the caller's toast. Otherwise what didn't go in stays listed until dismissed.
    if (!queue.current.some((u) => u.state === "failed" || u.state === "skipped")) clear();
    else sync();
    if (alive.current) cb.current.finished(added, failed);
  };

  const clear = () => {
    for (const u of queue.current) if (u.thumb) URL.revokeObjectURL(u.thumb);
    queue.current = [];
    sync();
  };

  /** Pictures to send: after the ones already going, or as a new run. */
  const add = (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    if (!running.current) clear();
    for (const file of pics) queue.current.push({ key: nextKey.current++, name: file.name, state: "waiting", sent: 0, file });
    sync();
    if (!running.current) void run();
  };

  /** Send no more: the one going up finishes. */
  const stop = () => {
    stopped.current = "Stopped before it went in";
  };

  const busy = uploads.some((u) => u.state === "waiting" || u.state === "preparing" || u.state === "sending");
  const node = uploads.length > 0 && <UploadTray uploads={uploads} busy={busy} onStop={stop} onDismiss={clear} />;
  return { add, busy, node };
}

function UploadTray({ uploads, busy, onStop, onDismiss }: { uploads: Upload[]; busy: boolean; onStop: () => void; onDismiss: () => void }) {
  const total = uploads.length;
  const over = uploads.filter((u) => u.state === "done" || u.state === "failed" || u.state === "skipped").length;
  const done = uploads.filter((u) => u.state === "done").length;
  const missed = uploads.filter((u) => u.state === "failed" || u.state === "skipped");
  const progress = uploads.reduce((sum, u) => sum + share(u), 0) / total;
  const stopping = busy && uploads.some((u) => u.state === "skipped");
  const pictures = (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`;

  return (
    <section className="uploads" aria-label="Adding photos" data-busy={busy}>
      <div className="uploads-head">
        <strong role="status">
          {busy ? `Adding ${Math.min(over + 1, total)} of ${total}` : `Added ${done} of ${pictures(total)}`}
        </strong>
        {busy ? (
          <button className="ghost" onClick={onStop} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="ghost" onClick={onDismiss}>OK</button>
        )}
      </div>
      <div
        className="uploads-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        style={{ ["--p" as string]: progress } as CSSProperties}
      />
      <ol className="uploads-strip" aria-hidden>
        {uploads.map((u) => (
          <li key={u.key} data-state={u.state} title={u.why ? `${u.name}: ${u.why}` : u.name}>
            {u.thumb && <img src={u.thumb} alt="" />}
            {u.state === "sending" && <i style={{ ["--p" as string]: u.sent } as CSSProperties} />}
          </li>
        ))}
      </ol>
      {!busy && missed.length > 0 && (
        <ul className="uploads-missed">
          {missed.map((u) => (
            <li key={u.key}>
              <strong>{u.name}</strong> {u.why}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
