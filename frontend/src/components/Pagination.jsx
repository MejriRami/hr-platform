import React, { useEffect, useMemo, useRef, useState } from 'react';
import './Pagination.css';

// Splits `items` into pages. The page goes back to 1 when `resetKey` changes
// (pass the search/filter values), and is clamped if the list shrinks -- so a
// background refresh after a save keeps the user on their page.
export const usePagination = (items, pageSize, resetKey) => {
  const [page, setPage] = useState(1);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const resetSignature = JSON.stringify(resetKey ?? null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPage(1);
  }, [resetSignature]);

  const currentPage = Math.min(page, pageCount);
  const pageItems = useMemo(
    () => items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [items, currentPage, pageSize]
  );

  return { page: currentPage, setPage, pageCount, pageItems, total, pageSize };
};

const pageNumbers = (page, pageCount) => {
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…' + p);
    out.push(p);
  });
  return out;
};

const Pagination = ({ page, setPage, pageCount, total, pageSize, scrollToTop = true }) => {
  if (total <= pageSize) return null;

  const go = (p) => {
    setPage(Math.max(1, Math.min(pageCount, p)));
    if (scrollToTop && typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav className="app-pagination" aria-label="Pagination">
      <span className="app-pagination-info">
        {from}–{to} / {total}
      </span>
      <div className="app-pagination-pages">
        <button type="button" onClick={() => go(page - 1)} disabled={page === 1} aria-label="Previous page">
          ‹
        </button>
        {pageNumbers(page, pageCount).map((p) =>
          typeof p === 'string' ? (
            <span key={p} className="app-pagination-gap">…</span>
          ) : (
            <button
              type="button"
              key={p}
              className={p === page ? 'active' : ''}
              onClick={() => go(p)}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </button>
          )
        )}
        <button type="button" onClick={() => go(page + 1)} disabled={page === pageCount} aria-label="Next page">
          ›
        </button>
      </div>
    </nav>
  );
};

export default Pagination;
