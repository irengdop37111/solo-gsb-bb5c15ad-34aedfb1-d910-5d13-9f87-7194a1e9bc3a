import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  buildRestartPlan,
  validateServices,
  diffChangedPaths,
  RestartError,
  RESTART_CODES,
} from '../src/restart.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_RESTART_PLAN_REQUEST,
} from '../src/example.js';
import { readFileSync } from 'node:fs';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function createRecord(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/merges', payload });
  return res.json();
}

function plan(id, services) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/restart-plan`,
    payload: { services },
  });
}

/* ------------------------------- happy path ------------------------------ */

test('restart plan on the canned example: hits, propagation, SCC grouping and rounds', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await plan(record.id, EXAMPLE_RESTART_PLAN_REQUEST.services);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);

  // base -> merged: replicas 2->3, servers array changed, tracing flipped,
  // retries added. The servers array records only its own path.
  assert.deepEqual(body.changedPaths, [
    '/features/retries',
    '/features/tracing',
    '/replicas',
    '/servers',
  ]);

  // Direct hits in both prefix directions: config-loader reads the changed
  // /features subtree; worker reads inside the changed /servers array.
  assert.deepEqual(body.directHits, [
    {
      service: 'api-gateway',
      reads: ['/features/tracing', '/replicas'],
      changedPaths: ['/features/tracing', '/replicas'],
    },
    {
      service: 'config-loader',
      reads: ['/features'],
      changedPaths: ['/features/retries', '/features/tracing'],
    },
    {
      service: 'session-store',
      reads: ['/features/retries'],
      changedPaths: ['/features/retries'],
    },
    {
      service: 'worker',
      reads: ['/servers/0/host'],
      changedPaths: ['/servers'],
    },
  ]);

  // Propagation along reversed dependencies: dashboard reads nothing changed
  // but depends on api-gateway; cache is pulled in by its mutual dependency
  // with session-store. billing reads /app and is left out entirely.
  assert.deepEqual(body.affected, [
    'api-gateway',
    'cache',
    'config-loader',
    'dashboard',
    'session-store',
    'worker',
  ]);

  // cache <-> session-store collapse into one group; round 0 holds every
  // ready group sorted by smallest member id ("cache" < "config-loader").
  assert.deepEqual(body.rounds, [
    [['cache', 'session-store'], ['config-loader']],
    [['api-gateway']],
    [['dashboard'], ['worker']],
  ]);

  assert.deepEqual(body.summary, {
    services: 7,
    changedPaths: 4,
    directlyAffected: 4,
    affected: 6,
    groups: 5,
    rounds: 3,
  });
});

/* ------------------------------ diff semantics --------------------------- */

test('diff distinguishes missing members from explicit nulls', async () => {
  const record = await createRecord({
    base: { a: 1, b: null, c: 2, d: { e: 1 } },
    patchA: [
      { op: 'remove', path: '/a' },
      { op: 'replace', path: '/b', value: 2 },
      { op: 'replace', path: '/c', value: null },
      { op: 'add', path: '/f', value: null },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  assert.deepEqual(record.merged, { b: 2, c: null, d: { e: 1 }, f: null });
  const res = await plan(record.id, []);
  assert.equal(res.statusCode, 200);
  // /a removed, /b null->2, /c 2->null, /f added as null; /d untouched.
  assert.deepEqual(res.json().changedPaths, ['/a', '/b', '/c', '/f']);
});

test('array changes record only the array path, never element paths', async () => {
  const record = await createRecord({
    base: { list: [1, 2, 3], same: [1, 2], nested: { arr: [{ h: 1 }] } },
    patchA: [
      { op: 'replace', path: '/list/1', value: 20 },
      { op: 'add', path: '/nested/arr/1', value: { h: 2 } },
    ],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  const res = await plan(record.id, []);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().changedPaths, ['/list', '/nested/arr']);
});

test('escaped keys are decoded before matching (segment, not string, prefix)', async () => {
  const record = await createRecord({
    base: { 'a/b': 1, 'c~d': 1 },
    patchA: [{ op: 'replace', path: '/a~1b', value: 2 }],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  const res = await plan(record.id, [
    { id: 'exact', reads: ['/a~1b'], dependsOn: [] },
    { id: 'two-segment', reads: ['/a/b'], dependsOn: [] },
    { id: 'tilde', reads: ['/c~0d'], dependsOn: [] },
    { id: 'root', reads: [''], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.changedPaths, ['/a~1b']);
  // "exact" decodes to ["a/b"] and hits; "two-segment" decodes to ["a","b"]
  // which is NOT a segment-prefix match; "tilde" reads an unchanged key;
  // the root read "" is a prefix of every path.
  assert.deepEqual(
    body.directHits.map((h) => h.service),
    ['exact', 'root'],
  );
  assert.deepEqual(body.affected, ['exact', 'root']);
});

test('a whole-document replace records the root path and hits every reader', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '', value: [1, 2] }],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  const res = await plan(record.id, [
    { id: 'deep', reads: ['/a/b'], dependsOn: [] },
    { id: 'root', reads: [''], dependsOn: [] },
    { id: 'deaf', reads: [], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.changedPaths, ['']);
  assert.deepEqual(
    body.directHits.map((h) => h.service),
    ['deep', 'root'],
  );
  // "deaf" declares no reads, so nothing propagates to it either.
  assert.deepEqual(body.affected, ['deep', 'root']);
  assert.deepEqual(body.rounds, [[['deep'], ['root']]]);
});

test('string-prefix alone is not enough: /features2 does not match /features', async () => {
  const record = await createRecord({
    base: { features: { tracing: false } },
    patchA: [{ op: 'replace', path: '/features/tracing', value: true }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'parent', reads: ['/features'], dependsOn: [] },
    { id: 'sibling', reads: ['/features2'], dependsOn: [] },
    { id: 'deeper', reads: ['/features/tracing/mode'], dependsOn: [] },
    { id: 'exact', reads: ['/features/tracing'], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.changedPaths, ['/features/tracing']);
  assert.deepEqual(
    body.directHits.map((h) => h.service),
    ['deeper', 'exact', 'parent'],
  );
  assert.deepEqual(body.affected, ['deeper', 'exact', 'parent']);
});

/* ------------------------- propagation and grouping ---------------------- */

test('impact propagates along reversed dependencies transitively', async () => {
  const record = await createRecord({
    base: { x: 1, y: 1 },
    patchA: [{ op: 'replace', path: '/x', value: 2 }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'a', reads: ['/x'], dependsOn: [] },
    { id: 'b', reads: [], dependsOn: ['a'] },
    { id: 'c', reads: [], dependsOn: ['b'] },
    { id: 'd', reads: ['/y'], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.affected, ['a', 'b', 'c']);
  assert.deepEqual(body.rounds, [[['a']], [['b']], [['c']]]);
  assert.deepEqual(body.summary, {
    services: 4,
    changedPaths: 1,
    directlyAffected: 1,
    affected: 3,
    groups: 3,
    rounds: 3,
  });
});

test('diamond dependencies restart the shared dependency first', async () => {
  const record = await createRecord({
    base: { x: 1 },
    patchA: [{ op: 'replace', path: '/x', value: 2 }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'bottom', reads: [], dependsOn: ['left', 'right'] },
    { id: 'left', reads: [], dependsOn: ['top'] },
    { id: 'right', reads: [], dependsOn: ['top'] },
    { id: 'top', reads: ['/x'], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().rounds, [[['top']], [['left'], ['right']], [['bottom']]]);
});

test('mutual dependencies collapse into one group; dependents wait a round', async () => {
  const record = await createRecord({
    base: { c: 0 },
    patchA: [{ op: 'replace', path: '/c', value: 1 }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'x', reads: ['/c'], dependsOn: ['y'] },
    { id: 'y', reads: [], dependsOn: ['x'] },
    { id: 'z', reads: [], dependsOn: ['y'] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.affected, ['x', 'y', 'z']);
  assert.deepEqual(body.rounds, [[['x', 'y']], [['z']]]);
  assert.equal(body.summary.groups, 2);
});

test('a three-service cycle forms one sorted group; self-dependency is harmless', async () => {
  const record = await createRecord({
    base: { c: 0 },
    patchA: [{ op: 'replace', path: '/c', value: 1 }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'p', reads: ['/c'], dependsOn: ['q'] },
    { id: 'q', reads: [], dependsOn: ['r'] },
    { id: 'r', reads: [], dependsOn: ['p'] },
    { id: 's', reads: ['/c'], dependsOn: ['s'] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // one round: the cycle group (sorted by id) and the self-dependent service
  assert.deepEqual(body.rounds, [[[ 'p', 'q', 'r' ], ['s']]]);
  assert.equal(body.summary.groups, 2);
});

test('only affected services are orchestrated; unaffected dependencies are ignored', async () => {
  const record = await createRecord({
    base: { x: 1, y: 1 },
    patchA: [{ op: 'replace', path: '/x', value: 2 }],
    patchB: [],
  });
  const res = await plan(record.id, [
    { id: 'hit', reads: ['/x'], dependsOn: ['unrelated'] },
    { id: 'unrelated', reads: ['/y'], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // "unrelated" is not affected, so it is not orchestrated and does not
  // delay "hit" either.
  assert.deepEqual(body.affected, ['hit']);
  assert.deepEqual(body.rounds, [[['hit']]]);
});

/* -------------------------------- empty plan ----------------------------- */

test('no changes between base and merged returns an empty plan', async () => {
  const record = await createRecord({
    base: { a: 1 },
    patchA: [{ op: 'replace', path: '/a', value: 1 }],
    patchB: [],
  });
  assert.equal(record.status, 'clean');
  const res = await plan(record.id, [
    { id: 'svc', reads: ['/a'], dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.changedPaths, []);
  assert.deepEqual(body.directHits, []);
  assert.deepEqual(body.affected, []);
  assert.deepEqual(body.rounds, []);
  assert.deepEqual(body.summary, {
    services: 1,
    changedPaths: 0,
    directlyAffected: 0,
    affected: 0,
    groups: 0,
    rounds: 0,
  });
});

test('changes nobody reads return an empty plan; an empty service list is valid', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const nobody = await plan(record.id, [
    { id: 'svc', reads: ['/does/not/exist'], dependsOn: [] },
  ]);
  assert.equal(nobody.statusCode, 200);
  assert.deepEqual(nobody.json().changedPaths, [
    '/features/retries',
    '/features/tracing',
    '/replicas',
    '/servers',
  ]);
  assert.deepEqual(nobody.json().affected, []);
  assert.deepEqual(nobody.json().rounds, []);

  const empty = await plan(record.id, []);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().rounds, []);
  assert.equal(empty.json().summary.services, 0);
});

/* -------------------------- determinism / no mutation --------------------- */

test('restart plan does not modify the stored record and is byte-for-byte deterministic', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const services = EXAMPLE_RESTART_PLAN_REQUEST.services;
  const first = await plan(record.id, services);
  const second = await plan(record.id, services);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);

  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  const stored = fetched.json();
  assert.equal(stored.status, 'clean');
  assert.deepEqual(stored.base, EXAMPLE_REQUEST.base);
  assert.deepEqual(stored.patchA, EXAMPLE_REQUEST.patchA);
  assert.deepEqual(stored.patchB, EXAMPLE_REQUEST.patchB);
  assert.deepEqual(stored.merged, record.merged);
});

/* ------------------------------ 422 / 400 / 404 / 409 --------------------- */

test('invalid services return 422 INVALID_SERVICES with every problem collected', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await plan(record.id, [
    5,
    { id: '', reads: [], dependsOn: [] },
    { id: 'dup', reads: [], dependsOn: [] },
    { id: 'dup', reads: [], dependsOn: [] },
    { id: 'bad-read', reads: ['x'], dependsOn: [] },
    { id: 'bad-escape', reads: ['/a~2b'], dependsOn: [] },
    { id: 'reads-not-array', reads: '/a', dependsOn: [] },
    { id: 'deps-not-array', reads: [], dependsOn: 'x' },
    { id: 'bad-dep-entry', reads: [], dependsOn: [42] },
    { id: 'unknown-dep', reads: [], dependsOn: ['ghost'] },
    { id: 'extra', reads: [], dependsOn: [], note: 1 },
    { id: 'missing-reads', dependsOn: [] },
  ]);
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'Unprocessable Entity');
  assert.equal(body.code, 'INVALID_SERVICES');
  // the first "dup" (index 2) is the valid registration; only its second
  // occurrence (index 3) is reported
  assert.equal(body.invalid.length, 11);
  assert.deepEqual(
    body.invalid.map((e) => e.index),
    [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(body.invalid[0].id, null);
  assert.match(body.invalid[0].issues[0], /must be an object/);
  assert.match(body.invalid[1].issues[0], /"id" must be a non-empty string/);
  assert.match(body.invalid[2].issues[0], /duplicate service id "dup" \(first used at index 2\)/);
  assert.match(body.invalid[3].issues[0], /"reads\[0\]" is not a valid JSON Pointer: "x"/);
  assert.match(body.invalid[4].issues[0], /not a valid JSON Pointer/);
  assert.match(body.invalid[5].issues[0], /"reads" must be an array of JSON Pointers/);
  assert.match(body.invalid[6].issues[0], /"dependsOn" must be an array of service ids/);
  assert.match(body.invalid[7].issues[0], /"dependsOn\[0\]" must be a non-empty service id string/);
  assert.match(body.invalid[8].issues[0], /"dependsOn" references unknown service "ghost"/);
  assert.match(body.invalid[9].issues[0], /unknown property "note"/);
  assert.match(body.invalid[10].issues[0], /"reads" must be an array of JSON Pointers/);
});

test('malformed top-level bodies return 400, not 422', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  // missing required "services"
  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  // Unknown top-level properties are stripped by the platform-wide ajv
  // config (same as the other preview endpoints), not rejected.
  const stripped = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: { services: [], extra: true },
  });
  assert.equal(stripped.statusCode, 200);
  // A non-array `services` is coerced to a single-element array (Fastify/ajv
  // array coercion), so its single non-object "service" is reported as an
  // invalid service (422), consistent with other service-level problems.
  const coerced = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: { services: 'nope' },
  });
  assert.equal(coerced.statusCode, 422);
  assert.equal(coerced.json().code, 'INVALID_SERVICES');
  assert.match(coerced.json().invalid[0].issues[0], /must be an object/);
});

test('restart plan for an unknown id returns 404', async () => {
  const res = await plan('does-not-exist', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('restart plan on a conflict record returns 409 and does not modify it', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  // 409 takes precedence over 422 service validation
  const res = await plan(record.id, [{ id: 'bad', reads: ['x'], dependsOn: ['ghost'] }]);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'Conflict');
  assert.match(res.json().message, /status "conflict"/);
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` });
  assert.equal(fetched.json().status, 'conflict');
  assert.equal(fetched.json().merged, null);
});

/* ------------------------------ example file ----------------------------- */

test('examples/restart-plan-request.json mirrors the canned example and works end-to-end', async () => {
  const fromDisk = JSON.parse(
    readFileSync(new URL('../examples/restart-plan-request.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(fromDisk, EXAMPLE_RESTART_PLAN_REQUEST);
  const record = await createRecord(EXAMPLE_REQUEST);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: fromDisk,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.affected, [
    'api-gateway',
    'cache',
    'config-loader',
    'dashboard',
    'session-store',
    'worker',
  ]);
  assert.deepEqual(body.rounds, [
    [['cache', 'session-store'], ['config-loader']],
    [['api-gateway']],
    [['dashboard'], ['worker']],
  ]);
});

/* --------------------------------- units --------------------------------- */

test('validateServices normalizes valid services (escapes decoded, dependsOn deduplicated)', () => {
  const normalized = validateServices([
    { id: 's1', reads: ['/a~1b/0', ''], dependsOn: ['s2', 's2'] },
    { id: 's2', reads: [], dependsOn: [] },
  ]);
  assert.deepEqual(normalized[0].readsTokens, [['a/b', '0'], []]);
  assert.deepEqual(normalized[0].dependsOn, ['s2']);
  assert.deepEqual(normalized[1].readsTokens, []);
});

test('validateServices rejects a read pointer whose type is not a string', () => {
  assert.throws(
    () => validateServices([{ id: 's', reads: [42], dependsOn: [] }]),
    (err) =>
      err instanceof RestartError &&
      err.code === RESTART_CODES.INVALID_SERVICES &&
      err.details.invalid.length === 1 &&
      /"reads\[0\]" must be a JSON Pointer string/.test(err.details.invalid[0].issues[0]),
  );
});

test('diffChangedPaths distinguishes missing from null and records arrays wholesale', () => {
  const pointers = (base, merged) => diffChangedPaths(base, merged).map((c) => c.pointer);
  assert.deepEqual(pointers({ a: null }, {}), ['/a']);
  assert.deepEqual(pointers({}, { a: null }), ['/a']);
  assert.deepEqual(pointers({ a: null }, { a: null }), []);
  assert.deepEqual(pointers({ a: 1 }, { a: null }), ['/a']);
  assert.deepEqual(pointers({ l: [1] }, { l: [1, 2] }), ['/l']);
  assert.deepEqual(pointers({ l: [1, 2] }, { l: [1, 2] }), []);
  assert.deepEqual(pointers({ l: [1] }, { l: { 0: 1 } }), ['/l']);
  assert.deepEqual(pointers(1, 2), ['']);
  assert.deepEqual(pointers({ a: 1 }, { a: 1 }), []);
  // escaped keys round-trip through the formatter
  assert.deepEqual(pointers({ 'a/b': 1 }, { 'a/b': 2 }), ['/a~1b']);
});

test('buildRestartPlan is a pure function of the record and services', () => {
  const record = {
    id: 'x',
    status: 'clean',
    base: { a: 1, b: [1] },
    merged: { a: 2, b: [1, 2] },
  };
  const snapshot = structuredClone(record);
  const services = validateServices([
    { id: 's1', reads: ['/a'], dependsOn: [] },
    { id: 's2', reads: ['/b/0'], dependsOn: ['s1'] },
  ]);
  const p1 = buildRestartPlan(record, services);
  const p2 = buildRestartPlan(record, services);
  assert.deepEqual(p1, p2);
  assert.deepEqual(p1.changedPaths, ['/a', '/b']);
  assert.deepEqual(p1.affected, ['s1', 's2']);
  // s2 depends on s1, so it restarts one round later
  assert.deepEqual(p1.rounds, [[['s1']], [['s2']]]);
  assert.deepEqual(record, snapshot); // record untouched
});
