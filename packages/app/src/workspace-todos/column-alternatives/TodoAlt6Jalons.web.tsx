/* eslint-disable react-perf/jsx-no-new-object-as-prop -- Local interactive design prototype. */
import { groupTasks, type HybridProps } from "./hybrid-shared";

export default function TodoAlt6Jalons({ tasks, renderTask, renderCompleted }: HybridProps) {
  const groups = groupTasks(tasks);
  return (
    <div className="panel-scroll hybrid jalons">
      <div className="intro">
        <span className="eyebrow">Panorama × Parcours · 01</span>
        <h2>Avancer, étape par étape</h2>
        <p>Les tâches actives au cœur de chaque étape.</p>
      </div>
      <div className="jalon-stack">
        {groups.map((group, i) => {
          const done = group.tasks.filter((t) => t.status === "done").length;
          const pending = group.tasks.filter((t) => t.status !== "done");
          return (
            <details
              className={`jalon-block ${pending.length ? "ongoing" : "finished"}`}
              key={group.title}
              open={pending.length > 0}
            >
              <summary>
                <span className="phase-index">
                  {pending.length ? String(i + 1).padStart(2, "0") : "✓"}
                </span>
                <span className="jalon-heading">
                  <strong>{group.title}</strong>
                  <span className="jalon-summary">
                    {pending.length
                      ? `${pending.length} tâche${pending.length > 1 ? "s restantes" : " restante"}`
                      : "Étape terminée"}
                    <span>
                      {done}/{group.tasks.length}
                    </span>
                  </span>
                  <span className="mini-track">
                    <i style={{ width: `${(done / group.tasks.length) * 100}%` }} />
                  </span>
                </span>
                <span className="disclosure">⌄</span>
              </summary>
              <div className="jalon-tasks">
                {pending.map(renderTask)}
                {renderCompleted(group.tasks)}
              </div>
            </details>
          );
        })}
      </div>
      <p className="hybrid-hint">Titres entiers · Notes au clic · Historique replié</p>
    </div>
  );
}
