/* eslint-disable react-perf/jsx-no-new-object-as-prop -- Local interactive design prototype. */
import { groupTasks, type HybridProps } from "./hybrid-shared";

export default function TodoAlt8Croisee({ tasks, renderTask }: HybridProps) {
  const groups = groupTasks(tasks);
  const pending = tasks.filter((t) => t.status !== "done");
  return (
    <div className="hybrid croisee">
      <div className="cross-scroll">
        <div className="intro">
          <span className="eyebrow">Panorama × Parcours · 03</span>
          <h2>Le présent et le chemin</h2>
          <p>Tout ce qui avance, avec sa place dans le projet.</p>
        </div>
        <div className="cross-active">
          <div className="section-label">
            <span>À avancer maintenant</span>
            <span className="count">{pending.length}</span>
            <span className="live-dot" />
          </div>
          {pending.map((task) => {
            const i = groups.findIndex((g) => g.tasks.some((t) => t.id === task.id));
            return (
              <div className="cross-task" key={task.id}>
                <div className="phase-reference">
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  {groups[i].short}
                </div>
                {renderTask(task)}
              </div>
            );
          })}
          {pending.length === 0 && <p className="empty">Toutes les tâches sont terminées.</p>}
        </div>
      </div>
      <div className="cross-journey">
        <div className="section-label">Le chemin parcouru</div>
        {groups.map((group, i) => {
          const done = group.tasks.filter((t) => t.status === "done").length;
          return (
            <details className="journey-stop" key={group.title}>
              <summary>
                <span className={`journey-node ${done === group.tasks.length ? "finished" : ""}`}>
                  {done === group.tasks.length ? "✓" : i + 1}
                </span>
                <span className="journey-heading">
                  <strong>{group.short}</strong>
                  <span className="mini-track">
                    <i style={{ width: `${(done / group.tasks.length) * 100}%` }} />
                  </span>
                </span>
                <span className="fraction">
                  {done}/{group.tasks.length}
                </span>
                <span className="disclosure">⌄</span>
              </summary>
              <div className="journey-detail">{group.tasks.map(renderTask)}</div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
