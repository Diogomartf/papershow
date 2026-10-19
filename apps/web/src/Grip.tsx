// The handle for dragging to sort (see sortable.ts).

/** Six dots: something you can pick up and move. */
export function Grip() {
  return (
    <span className="grip" data-sort-handle aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
        <circle cx="5" cy="3" r="1.3" />
        <circle cx="9" cy="3" r="1.3" />
        <circle cx="5" cy="7" r="1.3" />
        <circle cx="9" cy="7" r="1.3" />
        <circle cx="5" cy="11" r="1.3" />
        <circle cx="9" cy="11" r="1.3" />
      </svg>
    </span>
  );
}
