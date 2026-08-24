import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * What this deployment is serving, as one short string.
 *
 * It exists for the service worker, and the reason is worth stating plainly
 * because the failure it prevents is invisible and permanent.
 *
 * The worker caches the application shell under a version key and serves those
 * files cache-first, so the first paint is instant. That key used to be the
 * literal `construx-shell-v1`. A browser only installs a new worker when the
 * bytes of `/sw.js` change — and `sw.js` did not change on a deploy, so the
 * version never changed, so the cache was never invalidated. An installed
 * device kept serving the shell it downloaded on the day it installed, for
 * ever, with no way for anybody to notice: the API is current, the data is
 * right, and the JavaScript rendering it is from whenever that phone first
 * opened the app.
 *
 * This is the same class of bug as an over-long `max-age`, with two
 * differences that make it worse. It does not expire. And it lands on the
 * field device — the phone in a wet pocket on a site with one bar — which is
 * the one nobody can reach to clear.
 *
 * So the version is derived from the content itself. Change any file the
 * browser can load and the id changes, `sw.js` changes with it, the browser
 * installs the new worker, and `activate` deletes every cache that is not the
 * new one. Change nothing and it is byte-identical, so a redeploy of the same
 * code does not evict a working cache for no reason.
 */

/**
 * Directories under the frontend that no browser loads.
 *
 * `shots/` is 56MB of documentation screenshots — an order of magnitude larger
 * than everything else combined, read by the docs and by nothing at runtime.
 * Hashing it would make startup pay for it and would rev the shell version
 * every time somebody retook a screenshot.
 */
const NOT_SERVED = new Set(['shots']);

/** Every servable file under `root`, relative and sorted, so the walk is stable. */
async function servableFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (NOT_SERVED.has(path)) continue;
      found.push(...(await servableFiles(root, path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }

  // Sorted, because readdir order is filesystem order and differs between the
  // container and a developer's machine. An id that depended on it would
  // change without the content changing, which is the opposite of the point.
  return found.sort();
}

let computed: Promise<string> | undefined;

/**
 * The build id: 12 characters of a hash over every file a browser can load.
 *
 * Computed once per process and memoised. Not cached across restarts on
 * purpose — a restart is either a deploy, in which case it should be
 * recomputed, or a crash, in which case the cost is one directory walk.
 */
export function buildId(frontendRoot: string): Promise<string> {
  computed ??= (async () => {
    const digest = createHash('sha256');
    for (const path of await servableFiles(frontendRoot)) {
      // The path is hashed as well as the bytes, so moving a file to a new name
      // is a change even when its content is identical.
      digest.update(relative('', path).split(sep).join('/'));
      digest.update(await readFile(join(frontendRoot, path)));
    }
    return digest.digest('base64url').slice(0, 12);
  })();

  return computed;
}

/** Cleared between tests, which build several roots in one process. */
export function resetBuildId(): void {
  computed = undefined;
}
