/**
 * The offline outbox.
 *
 * The service worker deliberately does not cache `/v1/`, and it is right not
 * to: a cached API response is one identity's project data sitting somewhere
 * the access control cannot reach. But that left the installed application
 * able to *read* nothing and *write* nothing without signal, which on a site
 * with no coverage is the whole job.
 *
 * Writing is the half that matters. A supervisor standing at a work face with
 * no bars needs the record made *now*, at the time the work happened, and
 * reconciled later. That is exactly what `backend/src/field/sync.ts` was built
 * to do — operation-id idempotency, device timestamps preserved, deterministic
 * conflict resolution — and until now nothing in the browser fed it.
 *
 * This is that feed. It holds operations in IndexedDB until they are accepted,
 * and it is deliberately small: no retry policy of its own beyond "try again
 * when the browser says we are online", no partial-batch bookkeeping, no
 * background sync registration. The server is the authority on what happened
 * to each operation and answers per operation.
 *
 * ---
 *
 * **Four things this refuses to do.**
 *
 * It does not mint the record. `operationId` is client-minted and stable across
 * retries — that is what makes the push idempotent — but the event, the state
 * and the hash chain are the server's. A queued operation is a *request* that
 * work be recorded, not a record.
 *
 * It does not lie about the time. `deviceTimestamp` is when the operative
 * pressed the button, kept even if the batch flushes three days later, because
 * that is the fact a delay claim turns on. It is also, plainly, the device's
 * clock rather than the truth, which is why the server keeps its own
 * `recordedAt` alongside it.
 *
 * It does not queue governance. The server rejects a governance event pushed
 * from a device with `EVENT_NOT_PERMITTED_OFFLINE`, and queuing one here would
 * mean showing somebody an approval as "pending sync" that was never going to
 * be accepted. Better to refuse at the point of the press.
 *
 * It does not survive a sign-out. Clearing the queue on sign-out is the only
 * honest behaviour: the operations were authorised for one identity and the
 * device may be handed to another operative on the same site.
 */

const DB_NAME = 'construx-outbox';
const DB_VERSION = 2;
const STORE = 'operations';
/**
 * Captured files, waiting for the record that names them.
 *
 * Queuing the operation without the bytes would have left the field app exactly
 * where the platform was before the object store existed: a hash captured at a
 * work face, and the photograph itself on a handset that may be dropped in a
 * trench before it next sees signal. IndexedDB holds Blobs, so the file waits
 * beside the operation that refers to it.
 */
const FILES = 'files';

/**
 * Events a device may never originate.
 *
 * Not declared here — fetched. `GET /v1/permissions/matrix` publishes
 * `neverOffline` from the sync engine's own `FIELD_FORBIDDEN_EVENTS`, so the
 * refusal shown at the point of the press is the same rule that would refuse
 * the operation on flush. The first version of this file hardcoded a list of
 * eight plausible-looking event names and every one of them was wrong, which is
 * a fair demonstration of why settled decision 6 exists.
 *
 * Empty until loaded. An unloaded list means nothing is refused locally and the
 * server refuses on flush instead — degraded, not unsafe.
 */
let neverOffline = new Set();

/** Called once at sign-in, from the same fetch that loads the permission matrix. */
export function useNeverOffline(eventTypes) {
  neverOffline = new Set(eventTypes ?? []);
}

/** Whether this event can be captured with no signal. */
export function permittedOffline(eventType) {
  return !neverOffline.has(eventType);
}

/** Stable per install. Not an identity — it identifies the handset, not the person. */
export function deviceId() {
  const key = 'construx.deviceId';
  let id = null;
  try {
    id = localStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. A per-session id still gives the
    // server something stable to reconcile a single batch against.
  }
  if (!id) {
    id = `dev-${crypto.randomUUID()}`;
    try {
      localStorage.setItem(key, id);
    } catch {
      /* nothing to do; the id lives for this page only */
    }
  }
  return id;
}

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by operationId, so the same operation queued twice — a double
        // tap, a retry after a crash — is one row rather than two records.
        db.createObjectStore(STORE, { keyPath: 'operationId' });
      }
      if (!db.objectStoreNames.contains(FILES)) {
        // Keyed by content hash. The same photograph attached to two records is
        // one row, which is the same property the server's store has and for
        // the same reason.
        db.createObjectStore(FILES, { keyPath: 'hash' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(db, mode, run, storeName = STORE) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = run(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Queue one operation for the next flush.
 *
 * Returns the operation as stored, so a caller can show the operative what is
 * pending rather than pretending the work is filed.
 */
export async function queue({ projectId, eventType, entity, nextState, evidenceRefs, baseStateHash }) {
  if (!permittedOffline(eventType)) {
    throw new Error(`${eventType} is a governance action and must be performed online with approval.`);
  }

  const operation = {
    operationId: `op-${crypto.randomUUID()}`,
    projectId,
    deviceId: deviceId(),
    // The device clock, and named as such. When the work happened is the fact a
    // delay claim turns on; the server keeps its own recordedAt beside it.
    deviceTimestamp: new Date().toISOString(),
    eventType,
    entity,
    nextState,
    ...(evidenceRefs ? { evidenceRefs } : {}),
    ...(baseStateHash ? { baseStateHash } : {}),
    source: 'PWA',
  };

  const db = await open();
  await transact(db, 'readwrite', (store) => store.put(operation));
  db.close();
  return operation;
}

/**
 * Hold the bytes of a captured file until the record that names them exists.
 *
 * The hash is computed here rather than accepted from a caller: it is the
 * address the file will be stored at and the value that goes into the event, so
 * the two must come from the same read of the same bytes.
 */
export async function queueFile(file, projectId) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  const db = await open();
  await transact(
    db,
    'readwrite',
    // The Blob itself, not a data URL. A base64 string of a 4MB photograph is
    // 5.5MB of text in a store the browser may evict for being large.
    (store) => store.put({ hash, blob: file, name: file.name, type: file.type, projectId, queuedAt: new Date().toISOString() }),
    FILES,
  );
  db.close();
  return hash;
}

/** Files still on the device, waiting to be stored. */
export async function pendingFiles() {
  const db = await open();
  const all = await transact(db, 'readonly', (store) => store.getAll(), FILES);
  db.close();
  return all;
}

/**
 * Give up on a file, deliberately.
 *
 * The one case `flushFiles` cannot resolve on its own: an operation the platform
 * rejected outright leaves its file waiting for a record that will never exist,
 * and nothing on the device can tell that apart from a record still in the
 * queue. So the decision is a person's, made from a screen that shows what is
 * being given up — which is why this is separate from the flush rather than a
 * timeout inside it. A photograph deleted by a timer is evidence nobody chose
 * to lose.
 */
export async function discardFile(hash) {
  const db = await open();
  await transact(db, 'readwrite', (store) => store.delete(hash), FILES);
  db.close();
}

/**
 * Upload every held file, and keep the ones the platform is not ready for.
 *
 * Run after the operations have been pushed, because an upload is refused
 * unless a ledger record already names its hash — the record has to land first.
 *
 * Two outcomes clear the file and nothing else does. A 2xx means the platform
 * holds it. A 422 means the bytes do not hash to the address they claim, which
 * cannot become true later and would keep the wrong file on the handset for
 * ever. A 404 — no record names this hash yet — keeps it, because the record
 * may simply be in the next batch. That leaves one honest gap: a file whose
 * operation was rejected outright waits indefinitely, so `pendingFiles` is
 * exposed for a screen to show what the device is still carrying.
 */
export async function flushFiles(upload) {
  const files = await pendingFiles();
  if (files.length === 0) return { stored: 0, waiting: 0, rejected: 0 };

  let stored = 0;
  let waiting = 0;
  let rejected = 0;
  const settled = [];

  for (const file of files) {
    try {
      await upload(`/v1/evidence/${encodeURIComponent(file.hash)}`, file.blob);
      stored += 1;
      settled.push(file.hash);
    } catch (error) {
      if (error?.status === 422) {
        rejected += 1;
        settled.push(file.hash);
      } else {
        waiting += 1;
      }
    }
  }

  if (settled.length > 0) {
    const db = await open();
    await transact(db, 'readwrite', (store) => {
      for (const hash of settled) store.delete(hash);
    }, FILES);
    db.close();
  }

  return { stored, waiting, rejected };
}

/** Everything still waiting, oldest first — the order the server replays in. */
export async function pending() {
  const db = await open();
  const all = await transact(db, 'readonly', (store) => store.getAll());
  db.close();
  return [...all].sort((a, b) => (a.deviceTimestamp < b.deviceTimestamp ? -1 : 1));
}

async function forget(operationIds) {
  if (operationIds.length === 0) return;
  const db = await open();
  await transact(db, 'readwrite', (store) => {
    for (const id of operationIds) store.delete(id);
  });
  db.close();
}

/**
 * Push every queued operation and clear what the server took.
 *
 * Batched per project because `sync/push` is project-scoped. An operation is
 * removed when the server has *decided* about it — accepted, duplicate, or
 * rejected outright — and kept only where no decision came back at all, which
 * is a transport failure rather than a verdict.
 *
 * A rejection is surfaced, not silently dropped: the operative recorded
 * something that did not stick, and finding out at the end of the week because
 * a figure looks wrong is how field records lose trust.
 */
export async function flush(post) {
  const queued = await pending();
  if (queued.length === 0) return { accepted: 0, duplicates: 0, conflicts: [], unsent: 0 };

  const byProject = new Map();
  for (const operation of queued) {
    const list = byProject.get(operation.projectId) ?? [];
    list.push(operation);
    byProject.set(operation.projectId, list);
  }

  let accepted = 0;
  let duplicates = 0;
  const conflicts = [];
  const settled = [];
  let unsent = 0;

  for (const [projectId, operations] of byProject) {
    let result;
    try {
      result = await post(`/v1/projects/${projectId}/sync/push?client=pwa`, {
        // `projectId` is in the path; sending it in the body too would fail the
        // route schema, which refuses unknown properties.
        operations: operations.map(({ projectId: _omit, ...rest }) => rest),
      });
    } catch {
      // No verdict came back. Keep every operation in this batch — dropping one
      // because the request failed is how a site record silently loses a day.
      unsent += operations.length;
      continue;
    }

    accepted += (result.accepted ?? []).length;
    duplicates += (result.duplicates ?? []).length;
    conflicts.push(...(result.conflicts ?? []));

    const decided = new Set([
      ...(result.accepted ?? []),
      ...(result.duplicates ?? []),
      ...(result.conflicts ?? []).map((c) => c.operationId),
    ]);
    for (const operation of operations) {
      if (decided.has(operation.operationId)) settled.push(operation.operationId);
      else unsent += 1;
    }
  }

  await forget(settled);
  return { accepted, duplicates, conflicts, unsent };
}

/**
 * Drop everything. Called on sign-out; the device may change hands on site.
 *
 * The held files go with the operations. A photograph captured under one
 * operative's session is that operative's record, and leaving it on the handset
 * to be flushed under the next person's token would put the wrong name against
 * it in the chain.
 */
export async function clear() {
  const db = await open();
  await transact(db, 'readwrite', (store) => store.clear());
  await transact(db, 'readwrite', (store) => store.clear(), FILES);
  db.close();
}
