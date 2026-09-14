"use client";

// The trading archetype picker (SPEC.md section 4). One of the three agent fields. Each archetype is
// a template that fixes the allowed-asset set and the risk caps; the creator picks exactly one. The
// slug is what api/launch.mjs stores in agents.archetype. Rendered as selectable cards so the creator
// can see the asset universe of each template at a glance.

import { ARCHETYPES, type ArchetypeSlug } from "@/lib/constants";
import styles from "@/app/create/create.module.css";

export function ArchetypePicker({
  value,
  onChange,
  disabled,
}: {
  value: ArchetypeSlug | "";
  onChange: (slug: ArchetypeSlug) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.archetypeGrid} role="radiogroup" aria-label="Trading archetype">
      {ARCHETYPES.map((a) => {
        const selected = a.slug === value;
        return (
          <button
            key={a.slug}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.archetypeCard} ${selected ? styles.archetypeCardSelected : ""}`}
            onClick={() => onChange(a.slug)}
            disabled={disabled}
          >
            <span className={styles.archetypeName}>
              {a.label}
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.03em",
                  padding: "2px 8px",
                  borderRadius: 999,
                  verticalAlign: "middle",
                  ...(a.alwaysOn
                    ? { color: "hsl(201 100% 10%)", background: "hsl(199 92% 74%)" }
                    : { color: "hsl(240 5% 66%)", background: "hsl(0 0% 100% / 0.08)" }),
                }}
              >
                {a.alwaysOn ? "24/7" : "US hours"}
              </span>
            </span>
            <span className={styles.archetypeNotes}>{a.notes}</span>
            <span className={styles.archetypeAssets}>
              {a.assets.map((t) => (
                <span key={t} className={styles.assetTag}>
                  {t}
                </span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
