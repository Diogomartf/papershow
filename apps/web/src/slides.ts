// SlideGen client: the sequence, what's live, and edits to both.
// Every mutation answers with the whole new state, so the UI never drifts.

export type Slide = {
  id: string;
  imageId: string;
  position: number;
  durationS: number;
  enabled: boolean;
  days: number[];
  start: string | null;
  end: string | null;
};

export type Live = { mode: "rotate" } | { mode: "pin"; imageId: string };

export type State = {
  now: number;
  live: Live;
  showing: {
    imageId: string;
    slideId: string | null;
    endsAt: number | null;
    clip: { startedAt: number; endsAt: number } | null;
    etag: string;
  } | null;
  slides: Slide[];
  upcoming: { slideId: string; at: number }[];
};

async function call(path: string, method = "GET", body?: unknown): Promise<State> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const getState = () => call("/api/state");
/** Resolves when anything changes, or the current clip turns over. */
export const waitState = () => call("/api/state/wait");
export const addSlide = (imageId: string, at?: number) => call("/api/slides", "POST", { imageId, at });
export const updateSlide = (id: string, patch: Partial<Slide>) => call(`/api/slides/${id}`, "PATCH", patch);
export const reorderSlides = (ids: string[]) => call("/api/slides/order", "PUT", { ids });
export const removeSlide = (id: string) => call(`/api/slides/${id}`, "DELETE");
export const setLive = (live: Live) => call("/api/live", "PUT", live);
