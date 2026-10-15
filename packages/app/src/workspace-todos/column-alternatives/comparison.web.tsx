/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Disposable local design exploration; callbacks stay beside the interactions they demonstrate. */
import { useState, type ReactNode } from "react";
import { INITIAL_TASKS, type Task } from "./fixtures";
import { CSS } from "./styles";
import { HYBRID_CSS } from "./hybrid-styles";
import TodoAlt6Jalons from "./TodoAlt6Jalons.web";
import TodoAlt7Etape from "./TodoAlt7Etape.web";
import TodoAlt8Croisee from "./TodoAlt8Croisee.web";

type Variant =
  | "original"
  | "panorama"
  | "focus"
  | "parcours"
  | "cartes"
  | "carnet"
  | "jalons"
  | "etape"
  | "croisee";
const VARIANTS: { id: Variant; name: string; idea: string; benefit: string }[] = [
  {
    id: "original",
    name: "Original",
    idea: "La fenêtre actuelle",
    benefit:
      "Reconstitution de ta capture : titres coupés, tâches terminées en premier, notes cachées.",
  },
  {
    id: "panorama",
    name: "Panorama",
    idea: "Tout comprendre en un regard",
    benefit:
      "Les tâches en cours d’abord. Des titres entiers, des notes à la demande et les tâches terminées repliées.",
  },
  {
    id: "focus",
    name: "Focus",
    idea: "Savoir quoi faire maintenant",
    benefit:
      "Une tâche au premier plan, son contexte et une action claire. Le reste reste accessible dans la file.",
  },
  {
    id: "parcours",
    name: "Parcours",
    idea: "Voir le chemin parcouru",
    benefit:
      "Les tâches sont regroupées en étapes. Ces regroupements sont illustratifs : ils n’existent pas encore dans les données.",
  },
  {
    id: "cartes",
    name: "Cartes",
    idea: "Reconnaître les tâches visuellement",
    benefit:
      "Une grille de cartes pour parcourir le travail par blocs. Les filtres séparent ce qui avance de ce qui est terminé.",
  },
  {
    id: "carnet",
    name: "Carnet",
    idea: "Lire le contexte sans perdre le fil",
    benefit:
      "La liste en haut, le détail de la tâche sélectionnée en dessous. Les longues notes disposent d’un espace dédié.",
  },
  {
    id: "jalons",
    name: "Jalons",
    idea: "Le panorama de chaque étape",
    benefit:
      "Les listes restent ouvertes sur le travail actif ; les étapes finies et leurs détails se replient.",
  },
  {
    id: "etape",
    name: "Étape active",
    idea: "Le parcours en haut, la liste en dessous",
    benefit:
      "Un sélecteur d’étapes compact et toute la largeur pour lire les tâches. Clique sur une étape pour changer de liste.",
  },
  {
    id: "croisee",
    name: "Vue croisée",
    idea: "Les tâches d’abord, le parcours en repère",
    benefit:
      "Une liste transversale des tâches actives, puis une vue condensée des étapes et de leur historique.",
  },
];
const LABEL: Record<Task["status"], string> = {
  todo: "À faire",
  in_progress: "En cours",
  done: "Terminée",
};
const PATHS: Record<string, ReactNode> = {
  check: <path d="m5 12 4 4L19 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  todo: (
    <>
      <rect x="3" y="4" width="5" height="5" rx="1" />
      <path d="M12 6h9M12 17h9m-18 0 2 2 4-5" />
    </>
  ),
  folder: <path d="M3 7V5h6l2 2h10v13H3Z" />,
  chat: <path d="M4 4h16v12H9l-5 4Z" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10m0-5c8 0 12-1 12-5" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  reset: <path d="M3 9a9 9 0 1 1 0 6M3 3v6h6" />,
  note: <path d="M5 3h10l4 4v14H5Z M14 3v5h5M8 12h8M8 16h6" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
};
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] || PATHS.todo}
    </svg>
  );
}
function Status({ status }: { status: Task["status"] }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {LABEL[status]}
    </span>
  );
}
interface TaskProps {
  task: Task;
  onStatus: (id: string, status: Task["status"]) => void;
}
function Check({ task, onStatus }: TaskProps) {
  return (
    <button
      type="button"
      className={`check ${task.status}`}
      aria-label={`${task.status === "done" ? "Rouvrir" : "Terminer"} : ${task.title}`}
      onClick={() => onStatus(task.id, task.status === "done" ? "todo" : "done")}
    >
      {task.status === "done" && <Icon name="check" size={13} />}
      {task.status === "in_progress" && <span />}
    </button>
  );
}
function TaskRow({ task, onStatus }: TaskProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`task-row ${task.status}`} data-task={task.id}>
      <div className="task-line">
        <Check task={task} onStatus={onStatus} />
        <button
          type="button"
          className="task-title"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {task.title}
        </button>
        <button
          type="button"
          className="icon-button reveal"
          onClick={() => setExpanded(!expanded)}
          aria-label={`Notes : ${task.title}`}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? "down" : "right"} size={14} />
        </button>
      </div>
      {expanded && (
        <div className="inline-notes">
          <p>{task.notes}</p>
          <Status status={task.status} />
        </div>
      )}
    </div>
  );
}
interface LayoutProps {
  tasks: Task[];
  onStatus: TaskProps["onStatus"];
}
function Completed({ tasks, onStatus }: LayoutProps) {
  const done = tasks.filter((t) => t.status === "done");
  if (done.length === 0) return null;
  return (
    <details className="completed">
      <summary>
        <Icon name="down" size={14} />
        <span>Terminées</span>
        <span className="count">{done.length}</span>
        <span className="completed-line" />
      </summary>
      <div>
        {done.map((task) => (
          <TaskRow key={task.id} task={task} onStatus={onStatus} />
        ))}
      </div>
    </details>
  );
}
function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </div>
  );
}
function Panorama({ tasks, onStatus }: LayoutProps) {
  const active = tasks.filter((t) => t.status === "in_progress");
  const next = tasks.filter((t) => t.status === "todo");
  return (
    <div className="panel-scroll panorama">
      <div className="intro">
        <span className="eyebrow">Vue d’ensemble</span>
        <h2>Le travail qui avance</h2>
        <p>
          {active.length} tâches en cours · {tasks.filter((t) => t.status === "done").length}{" "}
          terminées
        </p>
      </div>
      <SectionLabel count={active.length}>En cours</SectionLabel>
      <div className="active-rail">
        {active.map((task) => (
          <TaskRow key={task.id} task={task} onStatus={onStatus} />
        ))}
      </div>
      {next.length > 0 && (
        <>
          <SectionLabel count={next.length}>À faire</SectionLabel>
          {next.map((task) => (
            <TaskRow key={task.id} task={task} onStatus={onStatus} />
          ))}
        </>
      )}
      <Completed tasks={tasks} onStatus={onStatus} />
      <div className="quiet-note">
        <Icon name="note" />
        <span>Cliquer sur un titre révèle ses notes.</span>
      </div>
    </div>
  );
}
function Focus({ tasks, onStatus }: LayoutProps) {
  const pending = tasks.filter((t) => t.status !== "done");
  const [selected, setSelected] = useState(pending[0]?.id);
  const task = pending.find((t) => t.id === selected) || pending[0];
  return (
    <div className="panel-scroll focus">
      <div className="intro">
        <span className="eyebrow">Une chose à la fois</span>
        <h2>Le prochain pas</h2>
      </div>
      {task ? (
        <>
          <article className="focus-card">
            <div className="focus-meta">
              <span className="focus-orb">
                <Icon name="arrow" size={20} />
              </span>
              <Status status={task.status} />
            </div>
            <h3>{task.title}</h3>
            <p>{task.notes}</p>
            <button type="button" className="primary" onClick={() => onStatus(task.id, "done")}>
              <Icon name="check" />
              Marquer comme terminée
            </button>
          </article>
          <SectionLabel count={pending.length - 1}>Les autres tâches</SectionLabel>
          <div className="focus-queue">
            {pending
              .filter((t) => t.id !== task.id)
              .map((t, i) => (
                <button
                  type="button"
                  key={t.id}
                  className="queue-row"
                  onClick={() => setSelected(t.id)}
                >
                  <span className="queue-number">{String(i + 2).padStart(2, "0")}</span>
                  <span>{t.title}</span>
                  <Icon name="arrow" size={14} />
                </button>
              ))}
          </div>
        </>
      ) : (
        <p className="empty">Tout est terminé. Une nouvelle idée ?</p>
      )}
      <Completed tasks={tasks} onStatus={onStatus} />
    </div>
  );
}
const GROUPS = [
  { title: "Interactions & interface", subtitle: "Les bases sont en place", indices: [0, 1, 2] },
  {
    title: "Handoff & version locale",
    subtitle: "Finaliser la mise en service",
    indices: [3, 4, 5, 6, 7],
  },
  { title: "Conversations interactives", subtitle: "Enrichir les échanges", indices: [8] },
];
function Parcours({ tasks, onStatus }: LayoutProps) {
  return (
    <div className="panel-scroll parcours">
      <div className="intro">
        <span className="eyebrow">Du début à la suite</span>
        <h2>Un projet, trois étapes</h2>
        <p>Les tâches liées se lisent ensemble.</p>
      </div>
      <div className="timeline">
        {GROUPS.map((group, i) => {
          const subset = group.indices.map((n) => tasks[n]).filter(Boolean);
          const done = subset.filter((t) => t.status === "done").length;
          const finished = done === subset.length;
          return (
            <details
              className={`milestone ${finished ? "finished" : ""}`}
              key={group.title}
              open={!finished}
            >
              <summary>
                <span className="milestone-marker">{finished ? <Icon name="check" /> : i + 1}</span>
                <div>
                  <strong>{group.title}</strong>
                  <small>{group.subtitle}</small>
                </div>
                <span className="fraction">
                  {done}/{subset.length}
                </span>
                <Icon name="down" size={14} />
              </summary>
              <div className="milestone-content">
                {subset.map((task) => (
                  <TaskRow key={task.id} task={task} onStatus={onStatus} />
                ))}
              </div>
            </details>
          );
        })}
      </div>
      {tasks.length > 9 && (
        <>
          <SectionLabel>À organiser</SectionLabel>
          {tasks.slice(9).map((task) => (
            <TaskRow key={task.id} task={task} onStatus={onStatus} />
          ))}
        </>
      )}
      <div className="quiet-note">
        <Icon name="branch" />
        <span>Regroupement proposé pour cette maquette.</span>
      </div>
    </div>
  );
}
function Cartes({ tasks, onStatus }: LayoutProps) {
  const [filter, setFilter] = useState<Task["status"]>("in_progress");
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = tasks.filter((t) => t.status === filter);
  return (
    <div className="panel-scroll cartes">
      <div className="intro">
        <span className="eyebrow">Chaque tâche a sa place</span>
        <h2>Le tableau du projet</h2>
      </div>
      <div className="filters" aria-label="Filtrer les tâches">
        {(["in_progress", "todo", "done"] as const).map((status) => (
          <button
            type="button"
            key={status}
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
          >
            {status === "done" ? "Terminées" : LABEL[status]}
            <span>{tasks.filter((t) => t.status === status).length}</span>
          </button>
        ))}
      </div>
      <div className="card-grid">
        {filtered.map((task, index) => (
          <article className={`task-card tone-${index % 4}`} key={task.id}>
            <div className="card-top">
              <span className="card-number">
                {String(tasks.indexOf(task) + 1).padStart(2, "0")}
              </span>
              <Check task={task} onStatus={onStatus} />
            </div>
            <button
              type="button"
              className="task-title"
              aria-expanded={expanded === task.id}
              onClick={() => setExpanded(expanded === task.id ? null : task.id)}
            >
              {task.title}
            </button>
            <button
              type="button"
              className="card-bottom"
              onClick={() => setExpanded(expanded === task.id ? null : task.id)}
            >
              <Icon name="note" size={13} />
              {expanded === task.id ? "Fermer les notes" : "Lire les notes"}
              <Icon name="right" size={12} />
            </button>
            {expanded === task.id && <p className="card-notes">{task.notes}</p>}
          </article>
        ))}
      </div>
      {filtered.length === 0 && <p className="empty">Aucune tâche dans cette catégorie.</p>}
      <div className="quiet-note">
        <Icon name="grid" />
        <span>Ouvrir une carte pour retrouver son contexte.</span>
      </div>
    </div>
  );
}
function Carnet({ tasks, onStatus }: LayoutProps) {
  const [selected, setSelected] = useState(
    tasks.find((t) => t.status !== "done")?.id || tasks[0].id,
  );
  const task = tasks.find((t) => t.id === selected)!;
  const sorted = [...tasks].sort(
    (a, b) => Number(a.status === "done") - Number(b.status === "done"),
  );
  return (
    <div className="carnet">
      <div className="carnet-list">
        <SectionLabel count={tasks.length}>Les tâches du projet</SectionLabel>
        {sorted.map((t) => (
          <div className={`carnet-row ${selected === t.id ? "selected" : ""}`} key={t.id}>
            <Check task={t} onStatus={onStatus} />
            <button
              type="button"
              className="task-title"
              onClick={() => setSelected(t.id)}
              aria-pressed={selected === t.id}
            >
              {t.title}
            </button>
            <Icon name="right" size={12} />
          </div>
        ))}
      </div>
      <article className="reading-pane">
        <div className="reading-top">
          <span className="eyebrow">
            <Icon name="note" size={14} /> Détail de la tâche
          </span>
          <Status status={task.status} />
        </div>
        <h3>{task.title}</h3>
        <p>{task.notes || "Aucune note pour cette tâche."}</p>
        <div className="reading-actions">
          <label>
            Statut
            <select
              value={task.status}
              onChange={(e) => onStatus(task.id, e.target.value as Task["status"])}
            >
              <option value="todo">À faire</option>
              <option value="in_progress">En cours</option>
              <option value="done">Terminée</option>
            </select>
          </label>
        </div>
      </article>
    </div>
  );
}
function Original({ tasks, onStatus }: LayoutProps) {
  return (
    <aside className="original-window">
      <header>
        <Icon name="todo" />
        <strong>To-do</strong>
        <span>
          {tasks.filter((task) => task.status === "done").length}/{tasks.length}
        </span>
        <Icon name="close" size={14} />
      </header>
      <div className="original-scroll">
        {tasks.map((task) => (
          <div className="original-row" key={task.id}>
            <div>
              <span className="grip">⠿</span>
              <Check task={task} onStatus={onStatus} />
              <div className="fake-input">{task.title}</div>
              <span>···</span>
            </div>
            <small>
              › &nbsp; Notes <span>{LABEL[task.status]}</span>
            </small>
          </div>
        ))}
      </div>
      <div className="original-add">
        <div>Titre de la tâche</div>
        <div>Notes</div>
        <span>Ajouter une tâche</span>
      </div>
    </aside>
  );
}
function Workspaces({
  open,
  onToggle,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  count: number;
}) {
  return (
    <aside className="workspaces">
      <div className="macbar">
        <span />
        <span />
        <span />
        <small>Paseo</small>
      </div>
      <div className="nav-content">
        <div className="nav-title">
          Workspaces <Icon name="plus" />
        </div>
        <div className="project">
          <Icon name="folder" />
          Paseo <span>⌄</span>
        </div>
        <div className="workspace selected">
          <Icon name="branch" />
          <span>
            unique-chipmunk<small>To-do · alternatives</small>
          </span>
          <i />
        </div>
        <div className="workspace">
          <Icon name="branch" />
          <span>
            reliable-local-release<small>Version locale</small>
          </span>
        </div>
        <div className="workspace">
          <Icon name="branch" />
          <span>main</span>
        </div>
        <div className="project secondary">
          <Icon name="folder" />
          Poseidon <span>›</span>
        </div>
        <button
          type="button"
          className={`nav-todo ${open ? "is-open" : ""}`}
          onClick={onToggle}
          aria-expanded={open}
        >
          <Icon name="todo" />
          <span>To-do du projet</span>
          <span className="count">{count}</span>
        </button>
      </div>
      <footer>
        <span className="connection" />
        Mac Studio<span>Local</span>
      </footer>
    </aside>
  );
}
function Conversation() {
  return (
    <section className="conversation">
      <header>
        <div>
          <Icon name="chat" />
          <span>Repenser la To-do</span>
        </div>
        <div className="conversation-meta">
          Codex
          <span className="connection" />
          Prêt
        </div>
      </header>
      <div className="chat-body">
        <div className="chat-breadcrumb">
          Paseo <span>/</span> unique-chipmunk
        </div>
        <div className="user-message">
          J’aimerais une To-do lisible, dans une deuxième colonne à droite des workspaces, en pleine
          hauteur.
        </div>
        <div className="assistant-label">
          <span className="agent-mark">✳</span>Codex
        </div>
        <div className="assistant-message">
          <p>Garder le projet et ses tâches sous les yeux pendant la conversation.</p>
          <p>
            La colonne s’ouvre à côté des workspaces. Les titres prennent la place dont ils ont
            besoin et les notes se lisent au clic.
          </p>
        </div>
        <div className="chat-caption">
          <Icon name="todo" size={14} />
          <span>Panorama × Parcours : trois nouveaux mélanges à essayer.</span>
        </div>
      </div>
      <div className="composer">
        <span>Répondre à Codex…</span>
        <div>
          <Icon name="plus" />
          <small>Codex · GPT-6</small>
          <span className="send">
            <Icon name="arrow" />
          </span>
        </div>
      </div>
      <div className="composer-caption">Conversation de démonstration</div>
    </section>
  );
}
function Jalons(props: LayoutProps) {
  return (
    <TodoAlt6Jalons
      tasks={props.tasks}
      renderTask={(task) => <TaskRow key={task.id} task={task} onStatus={props.onStatus} />}
      renderCompleted={(tasks) => <Completed tasks={tasks} onStatus={props.onStatus} />}
    />
  );
}
function Etape(props: LayoutProps) {
  return (
    <TodoAlt7Etape
      tasks={props.tasks}
      renderTask={(task) => <TaskRow key={task.id} task={task} onStatus={props.onStatus} />}
      renderCompleted={(tasks) => <Completed tasks={tasks} onStatus={props.onStatus} />}
    />
  );
}
function Croisee(props: LayoutProps) {
  return (
    <TodoAlt8Croisee
      tasks={props.tasks}
      renderTask={(task) => <TaskRow key={task.id} task={task} onStatus={props.onStatus} />}
      renderCompleted={(tasks) => <Completed tasks={tasks} onStatus={props.onStatus} />}
    />
  );
}
function Demo({ variant }: { variant: Variant }) {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const done = tasks.filter((t) => t.status === "done").length;
  const onStatus: TaskProps["onStatus"] = (id, status) => {
    setTasks((current) => current.map((t) => (t.id === id ? { ...t, status } : t)));
    setNotice(
      status === "done" ? "Tâche terminée dans la maquette" : "Statut mis à jour dans la maquette",
    );
  };
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setTasks((current) => [
      ...current,
      { id: `demo-${Date.now()}`, title: draft.trim(), notes: "", status: "todo" },
    ]);
    setDraft("");
    setNotice("Tâche ajoutée dans la maquette");
  };
  const layouts: Record<Exclude<Variant, "original">, (props: LayoutProps) => ReactNode> = {
    panorama: Panorama,
    focus: Focus,
    parcours: Parcours,
    cartes: Cartes,
    carnet: Carnet,
    jalons: Jalons,
    etape: Etape,
    croisee: Croisee,
  };
  const Layout = variant === "original" ? null : layouts[variant];
  return (
    <div className={`demo-shell variant-${variant}`}>
      <Workspaces open={open} onToggle={() => setOpen(!open)} count={tasks.length} />
      {open && Layout && (
        <aside className="todo-column" aria-label="Colonne To-do">
          <header className="panel-header">
            <Icon name="todo" />
            <strong>To-do</strong>
            <span className="project-label">Paseo</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Fermer la colonne"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" size={15} />
            </button>
          </header>
          <div className="progress-block">
            <div>
              <span>Progression du projet</span>
              <strong>
                {done}
                <span> / {tasks.length}</span>
              </strong>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label="Tâches terminées"
              aria-valuenow={done}
              aria-valuemax={tasks.length}
              aria-valuemin={0}
            >
              <span style={{ width: `${(done / tasks.length) * 100}%` }} />
            </div>
          </div>
          <Layout tasks={tasks} onStatus={onStatus} />
          <form className="add-task" onSubmit={add}>
            <Icon name="plus" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ajouter une tâche…"
              aria-label="Nouvelle tâche"
            />
            <button
              type="submit"
              className="icon-button"
              disabled={!draft.trim()}
              aria-label="Ajouter la tâche"
            >
              <Icon name="arrow" />
            </button>
          </form>
          <div className="panel-foot">Maquette interactive · modifications locales</div>
        </aside>
      )}
      <Conversation />
      {open && variant === "original" && <Original tasks={tasks} onStatus={onStatus} />}
      <span className="sr-only" role="status">
        {notice}
      </span>
    </div>
  );
}
export default function ColumnsComparison() {
  const [active, setActive] = useState<Variant>("jalons");
  const [epoch, setEpoch] = useState(0);
  const current = VARIANTS.find((v) => v.id === active)!;
  return (
    <main className="todo-exploration">
      <style>{CSS + HYBRID_CSS}</style>
      <div className="comparison-header">
        <div>
          <span className="eyebrow">Paseo / Exploration To-do</span>
          <h1>Une place pour ce qui avance.</h1>
        </div>
        <span className="preview-badge">3 nouveaux mélanges · prototype local</span>
      </div>
      <div className="comparison-toolbar">
        <div className="variant-tabs extended" role="tablist" aria-label="Alternatives de la To-do">
          {VARIANTS.map((v, i) => (
            <button
              type="button"
              key={v.id}
              role="tab"
              aria-selected={active === v.id}
              aria-controls="comparison-stage"
              id={`tab-${v.id}`}
              onClick={() => setActive(v.id)}
            >
              {i > 0 && <span>{String(i).padStart(2, "0")}</span>}
              {v.name}
              {v.id === "jalons" && <i className="recommend-dot" />}
            </button>
          ))}
        </div>
        <button type="button" className="reset" onClick={() => setEpoch((n) => n + 1)}>
          <Icon name="reset" size={14} />
          Réinitialiser
        </button>
      </div>
      <div className="concept-description">
        <strong>{current.idea}</strong>
        <span>{current.benefit}</span>
      </div>
      <div id="comparison-stage" role="tabpanel" aria-labelledby={`tab-${active}`}>
        <Demo variant={active} key={`${active}-${epoch}`} />
      </div>
      <footer className="comparison-footer">
        <span>
          {active === "jalons"
            ? "Nouveau · Jalons — Panorama × Parcours"
            : `Piste ${VARIANTS.indexOf(current)} / 8 · ${current.name}`}
        </span>
        <span>Ouvre les notes · Coche une tâche · Essaie l’ajout</span>
        <span>Aucune modification de tes vraies tâches</span>
      </footer>
    </main>
  );
}
