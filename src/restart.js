/**
 * Service restart orchestration plan for a clean merge record.
 *
 * The client describes the services that consume the merged configuration:
 *
 *   { "services": [
 *     { "id": "api-gateway",                  // unique service id
 *       "reads": ["/replicas", "/features"],  // RFC 6901 pointers it reads
 *       "dependsOn": ["config-loader"] }      // ids of services it needs
 *   ] }
 *
 * The saved base and merged documents are compared recursively:
 *
 *   - object members are compared key by key; a member missing on either
 *     side is a change at the member path (a present null is a VALUE, never
 *     confused with absence);
 *   - two arrays that differ in any way record the ARRAY's own path only —
 *     element-level paths inside arrays are never reported;
 *   - any other difference (scalar/null change, container-kind change)
 *     records the path itself.
 *
 * A service is DIRECTLY affected when one of its (decoded) read pointers and
 * one of the (decoded) changed paths are segment-prefixes of each other, in
 * either direction: the service reads the changed subtree, or reads inside
 * it. The impact then propagates along the REVERSE of the dependsOn edges —
 * when a service is affected, every service that depends on it is affected
 * too, transitively.
 *
 * Only affected services are orchestrated. Strongly connected components of
 * the affected dependency graph (mutual dependencies) restart together as
 * one group; the condensation is emitted in rounds where a round holds every
 * group whose dependencies are all placed in earlier rounds. Groups are
 * ordered within a round by their smallest member id and the services inside
 * a group are sorted by id (UTF-16 code-unit order).
 *
 * The plan is a pure function of the stored record and the submitted
 * services: the record is never modified and repeated identical requests
 * produce identical responses. When base and merged are identical — or no
 * service reads a changed path — the plan is empty.
 */

import { deepEqual, formatPointer } from './merge.js';
import { parseRulePointer } from './constraint.js';

export const RESTART_CODES = Object.freeze({
  INVALID_SERVICES: 'INVALID_SERVICES',
});

export class RestartError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'RestartError';
    this.code = code;
    this.details = details;
  }
}

/* ---------------------------- service validation ------------------------- */

const SERVICE_KEYS = ['id', 'reads', 'dependsOn'];

/**
 * Validate the submitted services and return them normalized as
 * { id, reads, readsTokens, dependsOn } in request order (dependsOn
 * deduplicated, order of first appearance kept). Every problem is collected
 * (one entry per offending service, in request order) and reported by
 * throwing RestartError(INVALID_SERVICES).
 */
export function validateServices(services) {
  const invalid = [];
  const normalized = [];
  const seen = new Map(); // service id -> index of its first occurrence
  services.forEach((service, index) => {
    if (service === null || typeof service !== 'object' || Array.isArray(service)) {
      invalid.push({ index, id: null, issues: ['service must be an object'] });
      return;
    }
    const issues = [];
    for (const key of Object.keys(service)) {
      if (!SERVICE_KEYS.includes(key)) issues.push(`unknown property "${key}"`);
    }
    if (typeof service.id !== 'string' || service.id.length === 0) {
      issues.push('"id" must be a non-empty string');
    } else if (seen.has(service.id)) {
      issues.push(
        `duplicate service id "${service.id}" (first used at index ${seen.get(service.id)})`,
      );
    } else {
      seen.set(service.id, index);
    }
    const readsTokens = [];
    if (!Array.isArray(service.reads)) {
      issues.push('"reads" must be an array of JSON Pointers');
    } else {
      service.reads.forEach((pointer, i) => {
        const tokens = parseRulePointer(pointer);
        if (tokens === null) {
          issues.push(
            typeof pointer === 'string'
              ? `"reads[${i}]" is not a valid JSON Pointer: "${pointer}"`
              : `"reads[${i}]" must be a JSON Pointer string ("" or starting with "/")`,
          );
        } else {
          readsTokens.push(tokens);
        }
      });
    }
    const dependsOn = [];
    if (!Array.isArray(service.dependsOn)) {
      issues.push('"dependsOn" must be an array of service ids');
    } else {
      const seenDeps = new Set();
      service.dependsOn.forEach((dep, i) => {
        if (typeof dep !== 'string' || dep.length === 0) {
          issues.push(`"dependsOn[${i}]" must be a non-empty service id string`);
        } else if (!seenDeps.has(dep)) {
          seenDeps.add(dep);
          dependsOn.push(dep);
        }
      });
    }
    if (issues.length) {
      invalid.push({ index, id: typeof service.id === 'string' ? service.id : null, issues });
      return;
    }
    normalized.push({ id: service.id, reads: service.reads, readsTokens, dependsOn, index });
  });
  // Unknown dependencies are checked against the full id set, so they need a
  // second pass; the invalid list is sorted back into request order below.
  for (const service of normalized) {
    const issues = service.dependsOn
      .filter((dep) => !seen.has(dep))
      .map((dep) => `"dependsOn" references unknown service "${dep}"`);
    if (issues.length) invalid.push({ index: service.index, id: service.id, issues });
  }
  if (invalid.length) {
    invalid.sort((x, y) => x.index - y.index);
    throw new RestartError(`${invalid.length} of ${services.length} service(s) are invalid`, {
      code: RESTART_CODES.INVALID_SERVICES,
      invalid,
    });
  }
  return normalized;
}

/* --------------------------- base vs merged diff ------------------------- */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectChanges(base, merged, segments, out) {
  if (deepEqual(base, merged)) return;
  if (isPlainObject(base) && isPlainObject(merged)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(merged)]);
    // Dictionary order: plain Array.sort compares by UTF-16 code units, which
    // is locale-independent and stable across runs.
    for (const key of [...keys].sort()) {
      const inBase = Object.prototype.hasOwnProperty.call(base, key);
      const inMerged = Object.prototype.hasOwnProperty.call(merged, key);
      if (inBase && inMerged) {
        collectChanges(base[key], merged[key], [...segments, key], out);
      } else {
        // Member added or removed. A member present with value null is a
        // value, not an absence, so it never reaches this branch.
        out.push([...segments, key]);
      }
    }
    return;
  }
  // Two arrays that differ in any way record the array's own path only;
  // scalar/null changes and container-kind changes record this path.
  out.push(segments);
}

/**
 * Recursively compare base and merged and return the changed paths as
 * { pointer, tokens } pairs sorted by pointer (UTF-16 code-unit order).
 * Missing members and explicit nulls are distinguished; a changed array
 * contributes only the array's own path.
 */
export function diffChangedPaths(base, merged) {
  const out = [];
  collectChanges(base, merged, [], out);
  return out
    .map((tokens) => ({ pointer: formatPointer(tokens), tokens }))
    .sort((x, y) => compareStrings(x.pointer, y.pointer));
}

/* ------------------------------ impact analysis -------------------------- */

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0; // UTF-16 code-unit order, locale-independent
}

function isSegmentPrefix(a, b) {
  if (a.length > b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/** Decoded paths overlap when either is a segment-prefix of the other. */
function pathsOverlap(aTokens, bTokens) {
  return isSegmentPrefix(aTokens, bTokens) || isSegmentPrefix(bTokens, aTokens);
}

/**
 * Tarjan's strongly connected components. `nodes` and every successor list
 * must be sorted for a deterministic traversal. Returns the components (each
 * a sorted array of ids) sorted by their smallest member id.
 */
function stronglyConnectedComponents(nodes, successors) {
  const indexOf = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  function visit(v) {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of successors.get(v)) {
      if (!indexOf.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexOf.get(w)));
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component.sort(compareStrings));
    }
  }

  for (const v of nodes) {
    if (!indexOf.has(v)) visit(v);
  }
  return components.sort((x, y) => compareStrings(x[0], y[0]));
}

/* --------------------------------- entry --------------------------------- */

/**
 * Build the restart orchestration plan for a clean record. `services` must
 * already be normalized by validateServices. Returns
 * { changedPaths, directHits, affected, rounds, summary }.
 */
export function buildRestartPlan(record, services) {
  const changes = diffChangedPaths(record.base, record.merged);

  // Direct hits: a service whose decoded read pointer and a decoded changed
  // path are segment-prefixes of each other (in either direction).
  const directHits = [];
  const directlyAffected = new Set();
  for (const service of services) {
    const hitReads = new Set();
    const hitChanges = new Set();
    service.readsTokens.forEach((tokens, i) => {
      for (const change of changes) {
        if (pathsOverlap(tokens, change.tokens)) {
          hitReads.add(service.reads[i]);
          hitChanges.add(change.pointer);
        }
      }
    });
    if (hitReads.size) {
      directlyAffected.add(service.id);
      directHits.push({
        service: service.id,
        reads: [...hitReads].sort(compareStrings),
        changedPaths: [...hitChanges].sort(compareStrings),
      });
    }
  }
  directHits.sort((x, y) => compareStrings(x.service, y.service));

  // Impact propagates along the REVERSE of the dependsOn edges: when a
  // service is affected, every service that depends on it is affected too.
  const dependents = new Map(); // dependency id -> ids of its dependents
  for (const service of services) {
    for (const dep of service.dependsOn) {
      let list = dependents.get(dep);
      if (!list) {
        list = [];
        dependents.set(dep, list);
      }
      list.push(service.id);
    }
  }
  const affected = new Set(directlyAffected);
  const queue = [...directlyAffected];
  while (queue.length) {
    const id = queue.shift();
    for (const next of dependents.get(id) || []) {
      if (!affected.has(next)) {
        affected.add(next);
        queue.push(next);
      }
    }
  }

  // Orchestrate the affected services only. Edges point from a dependency to
  // its dependents, so a topological round places dependencies first.
  const nodes = [...affected].sort(compareStrings);
  const successors = new Map(nodes.map((id) => [id, []]));
  for (const service of services) {
    if (!affected.has(service.id)) continue;
    for (const dep of service.dependsOn) {
      if (affected.has(dep)) successors.get(dep).push(service.id);
    }
  }
  for (const list of successors.values()) list.sort(compareStrings);

  const components = stronglyConnectedComponents(nodes, successors);
  const groupOf = new Map(); // service id -> component index
  components.forEach((component, i) => {
    for (const id of component) groupOf.set(id, i);
  });

  // Condensation of the affected graph: contract each component, then take
  // Kahn layers — a round holds every group whose dependencies are all
  // placed in earlier rounds.
  const groupSuccessors = components.map(() => new Set());
  const indegree = components.map(() => 0);
  components.forEach((component, i) => {
    for (const id of component) {
      for (const next of successors.get(id)) {
        const j = groupOf.get(next);
        if (j !== i && !groupSuccessors[i].has(j)) {
          groupSuccessors[i].add(j);
          indegree[j] += 1;
        }
      }
    }
  });
  const rounds = [];
  let frontier = components.flatMap((_, i) => (indegree[i] === 0 ? [i] : []));
  while (frontier.length) {
    frontier.sort((x, y) => compareStrings(components[x][0], components[y][0]));
    rounds.push(frontier.map((i) => components[i]));
    const ready = [];
    for (const i of frontier) {
      for (const j of groupSuccessors[i]) {
        indegree[j] -= 1;
        if (indegree[j] === 0) ready.push(j);
      }
    }
    frontier = ready;
  }

  return {
    changedPaths: changes.map((change) => change.pointer),
    directHits,
    affected: nodes,
    rounds,
    summary: {
      services: services.length,
      changedPaths: changes.length,
      directlyAffected: directHits.length,
      affected: nodes.length,
      groups: components.length,
      rounds: rounds.length,
    },
  };
}
