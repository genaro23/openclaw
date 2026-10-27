# PR163995 worker identification proof

Synthetic same-profile worker rows rendered through the actual Lit Systems sidebar at head5cfbf393 plus the short-ID repair. Not a live worker allocation or full app integration proof. Before/after captures use the same fixture. Browser viewport650x420, scale2, sidebar280px. Width probes280px and240px showed no row overflow. Names may ellipsize sooner; status and identifier remain visible. Full-ID selection was checked in browser and the real controller regression. Existing six-character collision limitations unchanged.

The regression failed on original code (Attached/Attached) and passes with repair (123456 · Attached/abcdef · Attached). All39 Systems tests pass in6.01s Vitest duration,11.16s wrapper wall time. No new external resource, Gateway, or provider calls. No live installation.
