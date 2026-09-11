// Staggered scroll-reveal for the landing's step / feature cards.
// Attach the returned ref to an element that wraps ONE grid (see components/RevealGroup).
// The hook reveals the grid's direct children (the cards): it adds the global "reveal" class
// (opacity 0 / shifted down), then flips each to "in" as it scrolls into view.
//
// The "reveal" / "in" classes are defined GLOBALLY in app/globals.css, not in a CSS module,
// so these literal class names match. Each card's own `transition` (which includes opacity)
// drives the fade; we clear the per-card transition-delay after it reveals so later hover
// transitions are not staggered.

import { useEffect, useRef } from "react";

export function useScrollReveal<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // The wrapper holds a single grid; its children are the cards to reveal.
    const grid = root.firstElementChild;
    const cards = grid ? (Array.from(grid.children) as HTMLElement[]) : [];
    if (cards.length === 0) return;

    cards.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.transitionDelay = `${(i % 4) * 0.08}s`;
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          el.classList.add("in");
          io.unobserve(el);
          // Drop the stagger delay once revealed so hover feels immediate.
          window.setTimeout(() => {
            el.style.transitionDelay = "";
          }, 700);
        });
      },
      { threshold: 0.15 }
    );

    cards.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return containerRef;
}
