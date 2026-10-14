/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Local interactive design prototype. */
import { useState } from "react";
import { groupTasks, type HybridProps } from "./hybrid-shared";

export default function TodoAlt7Etape({ tasks, renderTask, renderCompleted }: HybridProps) {
  const groups = groupTasks(tasks);
  const [selected, setSelected] = useState(
    Math.max(
      0,
      groups.findIndex((g) => g.tasks.some((t) => t.status !== "done")),
    ),
  );
  const group = groups[selected];
  const pending = group.tasks.filter((t) => t.status !== "done");
  const done = group.tasks.length - pending.length;
  return (
    <div className="panel-scroll hybrid etape">
      <div className="intro">
        <span className="eyebrow">Panorama × Parcours · 02</span>
        <h2>Une étape, une liste claire</h2>
        <p>Le parcours reste visible. Tu choisis où regarder.</p>
      </div>
      <div className="stage-map" aria-label="Choisir une étape">
        {groups.map((g, i) => {
          const completed = g.tasks.filter((t) => t.status === "done").length;
          return (
            <button
              type="button"
              key={g.title}
              className={`stage-choice ${completed === g.tasks.length ? "finished" : ""}`}
              aria-pressed={selected === i}
              onClick={() => setSelected(i)}
            >
              <span className="stage-node">
                {completed === g.tasks.length ? "✓" : String(i + 1).padStart(2, "0")}
              </span>
              <strong>{g.short}</strong>
              <small>
                {completed}/{g.tasks.length}
              </small>
            </button>
          );
        })}
      </div>
      <div className="selected-stage">
        <div className="stage-kicker">
          <span>ÉTAPE {String(selected + 1).padStart(2, "0")}</span>
          <span>
            {done} sur {group.tasks.length} terminées
          </span>
        </div>
        <h3>{group.title}</h3>
        <div className="mini-track">
          <i style={{ width: `${(done / group.tasks.length) * 100}%` }} />
        </div>
      </div>
      <div className="stage-list">
        <div className="section-label">
          <span>À avancer</span>
          <span className="count">{pending.length}</span>
        </div>
        {pending.length ? (
          pending.map(renderTask)
        ) : (
          <div className="stage-success">
            <span>✓</span>
            <strong>Cette étape est terminée</strong>
            <p>Le détail reste accessible dans l’historique.</p>
          </div>
        )}
        {renderCompleted(group.tasks)}
      </div>
      <div className="stage-navigation">
        <button type="button" disabled={selected === 0} onClick={() => setSelected((n) => n - 1)}>
          ← Précédente
        </button>
        <button
          type="button"
          disabled={selected === groups.length - 1}
          onClick={() => setSelected((n) => n + 1)}
        >
          Suivante →
        </button>
      </div>
    </div>
  );
}
