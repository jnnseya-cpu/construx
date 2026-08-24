import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The unattended deploy.
 *
 * This is the one piece of the platform that changes production with nobody
 * watching, so what it refuses to do matters more than what it does. It is a
 * shell script rather than TypeScript because it runs on the host, outside the
 * container, before the thing it is deploying exists — which is exactly why it
 * needs testing from here: nothing else in the suite would notice it rot.
 *
 * These assert the safety properties, not the mechanics. Whether it uses
 * `docker compose up` or something else is an implementation detail; whether it
 * can put the site back after a bad build is not.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'deploy/autodeploy.sh');
const script = readFileSync(SCRIPT, 'utf8');

describe('the deploy script is a program the host can actually run', () => {
  it('parses as a shell script', () => {
    // Caught here rather than at 3am on the first push after a change. `sh -n`
    // parses without executing, so this is safe to run anywhere.
    execFileSync('sh', ['-n', SCRIPT]);
  });

  it('is executable, because systemd ExecStart does not invoke an interpreter', () => {
    // A unit whose ExecStart is a non-executable file fails with a permission
    // error that reads like a security problem and is a chmod.
    assert.equal(
      statSync(SCRIPT).mode & 0o111,
      0o111,
      'deploy/autodeploy.sh must be committed with the executable bit set',
    );
  });

  it('stops at the first error rather than continuing past one', () => {
    // Without `set -e` a failed `git fetch` falls through to comparing HEAD
    // against a stale ref, finding no difference, and reporting success — a
    // deploy that silently does nothing is worse than one that fails.
    assert.match(script, /^set -eu$/m, 'the script must run under set -eu');
  });
});

describe('what it refuses to do', () => {
  it('holds a non-blocking lock, so a slow build cannot accumulate a queue', () => {
    // The timer fires every minute and a build takes minutes. Queued runs would
    // each deploy whatever was current when they finally started, which is a
    // different commit from the one they were fired for.
    assert.match(script, /flock -n/, 'concurrent runs must fail fast rather than queue');
  });

  it('refuses to deploy over local commits instead of discarding them', () => {
    // A divergent checkout means somebody edited files on the server. Both
    // automatic answers are wrong: merging invents a commit nobody reviewed,
    // and resetting destroys the only copy of whatever they were doing.
    assert.match(script, /--ff-only/, 'the merge must be fast-forward only');
    assert.match(script, /diverged/i, 'and it must say so rather than failing silently');
  });

  it('does nothing at all when the branch has not moved', () => {
    // This runs 1,440 times a day. If the no-op path rebuilt, or logged, it
    // would either churn the container or bury real deploys in noise.
    const gate = /if \[ "\$CURRENT" = "\$TARGET" \]; then\n(?:.*\n)*?\s*exit 0\n/.exec(script);
    assert.ok(gate, 'there must be an early exit when HEAD already matches the branch');
    assert.doesNotMatch(gate[0], /docker|log /, 'the no-op path must not build or log');
  });
});

describe('what it does when a deploy goes wrong', () => {
  it('backs up the journal before it replaces anything', () => {
    // The order is the property. A backup taken after the pull is a backup of
    // whatever the new code did, which is not the thing anybody wants back.
    const backupAt = script.indexOf('ledger-$STAMP.jsonl');
    const mergeAt = script.indexOf('git merge --ff-only');
    assert.ok(backupAt > 0 && mergeAt > 0, 'both steps must exist');
    assert.ok(backupAt < mergeAt, 'the backup must be taken before the working tree changes');
  });

  it('waits for readiness rather than liveness', () => {
    // `/healthz` answers as soon as the process is up; `/readyz` answers when
    // the journal has finished replaying. Checking the wrong one would call a
    // container healthy while it is still answering "no such project".
    assert.match(script, /readyz/, 'the gate must be the readiness probe');
    assert.doesNotMatch(script, /CONSTRUX_HEALTH_URL:-[^}]*healthz/, 'healthz must not be the default gate');
  });

  it('puts the previous commit back when the new build never becomes ready', () => {
    assert.match(script, /git reset --hard/, 'a failed deploy must be reverted');
    assert.match(script, /rolling back/i, 'and it must say that it did');
  });

  it('rolls back only inside the window where rolling back is safe', () => {
    /*
     * The constraint from docs/RUNBOOK.md: the journal is forward-compatible
     * and NOT backward-compatible. An older image replaying a journal holding
     * an event type it does not know refuses to start — the closed catalogue
     * doing its job.
     *
     * So an automatic rollback is only safe while the new image has written
     * nothing. It is: replay finishes before the service is ready and appends
     * no events, so a container that never reached /readyz never wrote one.
     * A failure *after* readiness is a different situation and is deliberately
     * left to a person, and the script has to say so or the next reader will
     * "improve" it into a rollback that takes the site down permanently.
     */
    assert.match(
      script,
      /forward-compatible and not backward-compatible/,
      'the rollback constraint must be stated where somebody editing this would read it',
    );
  });

  it('exits non-zero on a failed deploy even when the rollback worked', () => {
    // Otherwise systemctl reports a clean run, `systemctl --failed` is empty,
    // and the branch quietly stops matching what is live.
    const rollbackBlock = script.slice(script.indexOf('rolling back'));
    assert.match(rollbackBlock, /exit 1/, 'a recovered deploy is still a failed deploy');
    assert.match(rollbackBlock, /exit 2/, 'a failed rollback must be distinguishable from it');
  });

  it('says where the backup is when it cannot recover', () => {
    // The one moment somebody is reading this output under pressure. Making
    // them work out the filename is how the wrong file gets restored.
    const critical = script.slice(script.indexOf('CRITICAL'));
    assert.match(critical, /RUNBOOK/, 'it must point at the runbook');
    assert.match(critical, /BACKUP_DIR|ledger-\$STAMP/, 'and name the backup it just took');
  });
});

describe('the systemd units match the script', () => {
  const service = readFileSync(resolve(ROOT, 'deploy/construx-deploy.service'), 'utf8');
  const timer = readFileSync(resolve(ROOT, 'deploy/construx-deploy.timer'), 'utf8');

  it('runs the script this suite is testing', () => {
    const execStart = /ExecStart=(.+)/.exec(service)?.[1] ?? '';
    assert.match(execStart, /deploy\/autodeploy\.sh$/, 'the unit must start the deploy script');
  });

  it('is oneshot, so a failed deploy shows as a failed unit', () => {
    // The default (`simple`) considers the unit started the moment the process
    // is spawned, so the exit code is never surfaced and every deploy looks
    // successful in `systemctl status`.
    assert.match(service, /^Type=oneshot$/m);
  });

  it('waits for docker rather than racing it after a reboot', () => {
    assert.match(service, /docker\.service/, 'the unit must order itself after docker');
  });

  it('does not fire before the host has settled', () => {
    // A deploy racing a cold start fails its readiness check for reasons that
    // have nothing to do with the commit, and rolls back a healthy release.
    const onBoot = /OnBootSec=(\d+)min/.exec(timer);
    assert.ok(onBoot && Number(onBoot[1]) >= 2, 'the first check must be at least a couple of minutes after boot');
  });

  it('catches up on a push made while the host was down', () => {
    assert.match(timer, /^Persistent=true$/m, 'a missed interval must run on the next boot');
  });

  it('gives a build room to finish before systemd kills it', () => {
    const timeout = /TimeoutStartSec=(\d+)/.exec(service);
    assert.ok(timeout && Number(timeout[1]) >= 600, 'a docker build plus a journal replay needs minutes, not seconds');
  });
});
