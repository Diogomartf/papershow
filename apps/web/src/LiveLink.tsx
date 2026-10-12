import { useState } from "react";
import { useLiveState } from "./live";

/** "Open /live", with a thumbnail of what the panel shows right now. */
export function LiveLink() {
  const { state } = useLiveState();
  const etag = state?.showing?.etag;
  const [failed, setFailed] = useState<string | null>(null);
  const shown = etag && failed !== etag;
  return (
    <a className="ghost live-link" href="/live" target="_blank" rel="noreferrer">
      <span className="live-thumb" data-on={!!shown}>
        {shown && <img src={`/live.png?e=${encodeURIComponent(etag)}`} alt="" onError={() => setFailed(etag)} />}
      </span>
      <span className="live-link-text">Open /live ↗</span>
    </a>
  );
}
