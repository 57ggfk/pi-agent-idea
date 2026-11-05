import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { usePiStore } from "../store/store";
import { hitsFromItems } from "../lib/search";
import { paintSearchHighlights, clearSearchHighlights, customHighlightsAvailable } from "../lib/highlight";
import { scrollToItem } from "../lib/scrollToItem";
import Icon from "./Icon";

/**
 * In-session search bar (spec 006 US2): Ctrl/Cmd+F or the toolbar button open
 * the same instance; Enter / Shift+Enter navigate the model hit list with
 * wrap-around; Esc closes and clears every highlight. Painting happens in the
 * DOM (`lib/highlight`); counting in the model (`lib/search`).
 */
export default function SessionSearch() {
  const search = usePiStore((s) => s.search);
  const items = usePiStore((s) => s.items);
  const openSearch = usePiStore((s) => s.openSearch);
  const closeSearch = usePiStore((s) => s.closeSearch);
  const setSearchQuery = usePiStore((s) => s.setSearchQuery);
  const setSearchIndex = usePiStore((s) => s.setSearchIndex);
  const searchGo = usePiStore((s) => s.searchGo);
  const pendingJump = usePiStore((s) => s.pendingSearchJump);
  const clearSearchJump = usePiStore((s) => s.clearSearchJump);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(
    () => (search.open ? hitsFromItems(items, search.query) : []),
    [search.open, search.query, items],
  );

  // Ctrl/Cmd+F opens the bar and steals focus (FR-004); the browser find bar
  // is suppressed by preventDefault.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // Landing from a Sessions search result: apply the query, then jump once the
  // hits exist (the transcript may still be loading when the click happened).
  useEffect(() => {
    if (!pendingJump) return;
    setSearchQuery(pendingJump.query);
  }, [pendingJump, setSearchQuery]);

  // Paint on every relevant commit (streaming updates included, FR-009).
  const listEl = () => document.querySelector<HTMLElement>(".message-list");
  useLayoutEffect(() => {
    if (!search.open || hits.length === 0) {
      clearSearchHighlights();
      return;
    }
    const el = listEl();
    if (el) paintSearchHighlights(el, search.query, hits, search.index);
  });

  // The current hit must be visible: scroll on index/jump changes.
  useEffect(() => {
    if (!search.open) return;
    const target = hits[search.index];
    const el = listEl();
    if (!target || !el) return;
    scrollToItem(el, target.itemId);
  }, [search.open, search.index, hits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Consume the pending jump once the transcript has been loaded and painted.
  useEffect(() => {
    if (!pendingJump || !search.open) return;
    if (hits.length === 0) return; // transcript not loaded yet
    setSearchIndex(pendingJump.hitIndex);
    clearSearchJump();
  }, [pendingJump, search.open, hits.length, setSearchIndex, clearSearchJump]);

  useEffect(() => {
    if (!search.open) clearSearchHighlights();
  }, [search.open]);

  if (!search.open) return null;

  const count = hits.length;
  const current = count === 0 ? 0 : search.index + 1;

  return (
    <div className="session-search" data-testid="search-bar" role="search">
      <input
        ref={inputRef}
        className="search-input"
        data-testid="search-input"
        type="text"
        placeholder="Search in session"
        value={search.query}
        autoFocus
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            searchGo(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeSearch();
          }
        }}
      />
      <span className="search-count" data-testid="search-count">
        {search.query.trim() ? `${current}/${count}` : ""}
      </span>
      {search.query.trim() && count === 0 ? (
        <span className="search-empty" data-testid="search-empty">
          No matches
        </span>
      ) : null}
      <button
        type="button"
        className="search-nav"
        aria-label="Previous match"
        data-testid="search-prev"
        onClick={() => searchGo(-1)}
      >
        <Icon name="chev-down" className="ic-sm search-flip" />
      </button>
      <button
        type="button"
        className="search-nav"
        aria-label="Next match"
        data-testid="search-next"
        onClick={() => searchGo(1)}
      >
        <Icon name="chev-down" className="ic-sm" />
      </button>
      <button
        type="button"
        className="search-nav"
        aria-label="Close search"
        data-testid="search-close"
        onClick={() => closeSearch()}
      >
        <Icon name="x" className="ic-sm" />
      </button>
      <span className="search-hint" data-testid="search-hint">
        {customHighlightsAvailable() ? "" : "compat"}
      </span>
    </div>
  );
}
