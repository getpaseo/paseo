import type { RepositoryGraphCommit } from "@getpaseo/protocol/messages";

export interface RepositoryGraphEdge {
  from: number;
  to: number;
  color: number;
  startsAtCommit: boolean;
}

export interface RepositoryGraphRowLayout {
  commit: RepositoryGraphCommit;
  column: number;
  color: number;
  edges: RepositoryGraphEdge[];
  laneCount: number;
  startsLane: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface Connection {
  target: number;
  branch: number;
}

interface Vertex {
  parents: number[];
  nextParent: number;
  branch: number | null;
  column: number;
  nextColumn: number;
  connections: Array<Connection | undefined>;
}

interface BranchLine {
  from: Point;
  to: Point;
}

interface Branch {
  color: number;
  lines: BranchLine[];
}

const OUTSIDE_GRAPH = -1;

function getNextParent(vertex: Vertex): number | null {
  return vertex.parents[vertex.nextParent] ?? null;
}

function addToBranch(vertex: Vertex, branch: number, column: number) {
  if (vertex.branch === null) {
    vertex.branch = branch;
    vertex.column = column;
  }
}

function getNextPoint(vertex: Vertex, row: number): Point {
  return { x: vertex.nextColumn, y: row };
}

function registerConnection(vertex: Vertex, column: number, target: number, branch: number) {
  if (column !== vertex.nextColumn) {
    return;
  }
  vertex.connections[column] = { target, branch };
  vertex.nextColumn += 1;
}

function findConnectionPoint(
  vertex: Vertex,
  row: number,
  target: number,
  branch: number,
): Point | null {
  const column = vertex.connections.findIndex(
    (connection) => connection?.target === target && connection.branch === branch,
  );
  return column === -1 ? null : { x: column, y: row };
}

function getAvailableColor(availableColors: number[], startAt: number): number {
  const color = availableColors.findIndex((end) => startAt > end);
  if (color !== -1) {
    return color;
  }
  availableColors.push(0);
  return availableColors.length - 1;
}

function joinExistingBranch(
  vertices: Vertex[],
  branches: Branch[],
  startAt: number,
  parent: number,
  parentBranch: number,
  lastPoint: Point,
) {
  const vertex = vertices[startAt];
  for (let row = startAt + 1; row < vertices.length; row += 1) {
    const current = vertices[row];
    const connection = findConnectionPoint(current, row, parent, parentBranch);
    const currentPoint = connection ?? getNextPoint(current, row);
    branches[parentBranch].lines.push({ from: lastPoint, to: currentPoint });
    registerConnection(current, currentPoint.x, parent, parentBranch);
    lastPoint = currentPoint;
    if (connection !== null) {
      vertex.nextParent += 1;
      return;
    }
  }
}

function addBranchPath(
  vertices: Vertex[],
  branches: Branch[],
  availableColors: number[],
  startAt: number,
) {
  let row = startAt;
  let vertex = vertices[row];
  let parent = getNextParent(vertex);
  let lastPoint = vertex.branch === null ? getNextPoint(vertex, row) : { x: vertex.column, y: row };

  const parentBranch = parent === null || parent === OUTSIDE_GRAPH ? null : vertices[parent].branch;
  const joinsExistingBranch =
    vertex.parents.length > 1 && vertex.branch !== null && parentBranch !== null;

  if (parent !== null && parent !== OUTSIDE_GRAPH && joinsExistingBranch) {
    joinExistingBranch(vertices, branches, startAt, parent, parentBranch, lastPoint);
    return;
  }

  const branchIndex = branches.length;
  const color = getAvailableColor(availableColors, startAt);
  const branch: Branch = { color, lines: [] };
  branches.push(branch);
  addToBranch(vertex, branchIndex, lastPoint.x);
  registerConnection(vertex, lastPoint.x, startAt, branchIndex);

  for (row = startAt + 1; row < vertices.length; row += 1) {
    const current = vertices[row];
    const reachesParent = parent === row;
    const currentPoint =
      reachesParent && current.branch !== null
        ? { x: current.column, y: row }
        : getNextPoint(current, row);
    branch.lines.push({ from: lastPoint, to: currentPoint });
    registerConnection(current, currentPoint.x, parent ?? OUTSIDE_GRAPH, branchIndex);
    lastPoint = currentPoint;

    if (reachesParent) {
      vertex.nextParent += 1;
      const parentAlreadyAssigned = current.branch !== null;
      addToBranch(current, branchIndex, currentPoint.x);
      vertex = current;
      parent = getNextParent(vertex);
      if (parent === null || parentAlreadyAssigned) {
        break;
      }
    }
  }

  if (row === vertices.length && parent === OUTSIDE_GRAPH) {
    vertex.nextParent += 1;
  }
  availableColors[color] = row;
}

function createVertices(commits: RepositoryGraphCommit[]): Vertex[] {
  const commitRows = new Map(commits.map((commit, row) => [commit.sha, row]));
  return commits.map((commit) => ({
    parents: commit.parents.map((sha) => commitRows.get(sha) ?? OUTSIDE_GRAPH),
    nextParent: 0,
    branch: null,
    column: 0,
    nextColumn: 0,
    connections: [],
  }));
}

export function layoutRepositoryGraph(
  commits: RepositoryGraphCommit[],
): RepositoryGraphRowLayout[] {
  const vertices = createVertices(commits);
  const branches: Branch[] = [];
  const availableColors: number[] = [];

  let row = 0;
  while (row < vertices.length) {
    const vertex = vertices[row];
    if (getNextParent(vertex) !== null || vertex.branch === null) {
      addBranchPath(vertices, branches, availableColors, row);
    } else {
      row += 1;
    }
  }

  const edges = commits.map((): RepositoryGraphEdge[] => []);
  const incomingColumns = commits.map(() => new Set<number>());
  for (const branch of branches) {
    for (const line of branch.lines) {
      const vertex = vertices[line.from.y];
      edges[line.from.y].push({
        from: line.from.x,
        to: line.to.x,
        color: branch.color,
        startsAtCommit: line.from.x === vertex.column,
      });
      incomingColumns[line.to.y].add(line.to.x);
    }
  }

  return commits.map((commit, index) => {
    const vertex = vertices[index];
    const branch = branches[vertex.branch ?? 0];
    const rowColumns = [
      vertex.column,
      ...incomingColumns[index],
      ...edges[index].flatMap((edge) => [edge.from, edge.to]),
    ];
    return {
      commit,
      column: vertex.column,
      color: branch?.color ?? 0,
      edges: edges[index],
      laneCount: Math.max(...rowColumns) + 1,
      startsLane: !incomingColumns[index].has(vertex.column),
    };
  });
}
