import { describe, expect, test } from 'bun:test';

/*
 * Structural checks on .github/workflows/release.yml. The push-to-main path
 * itself can only be exercised in real CI.
 */

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
}

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on: { push: { branches?: string[]; tags?: string[] } };
  jobs: Record<string, Job>;
}

const workflow = Bun.YAML.parse(
  await Bun.file(new URL('../.github/workflows/release.yml', import.meta.url)).text()
) as Workflow;
const { jobs } = workflow;
const INSTALLS = /\b(?:bun install|bun add|npm install|npm ci)\b/u;

function step(job: Job | undefined, name: string): Step | undefined {
  return job?.steps.find((candidate) => candidate.name === name);
}

describe('release workflow', () => {
  test('runs on v* tags and on every push to main', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'], tags: ['v*'] });
  });

  test('jobs that can write never install dependencies', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const writes = Object.values(job.permissions ?? {}).includes('write');
      if (writes) {
        for (const { run = '' } of job.steps) {
          expect({ job: name, installs: INSTALLS.test(run) }).toEqual({
            job: name,
            installs: false,
          });
        }
      }
    }
  });

  test('pending and tag hold only the permissions they need and check nothing out', () => {
    expect(jobs.pending?.permissions).toEqual({ contents: 'read' });
    expect(jobs.tag?.permissions).toEqual({ contents: 'write', actions: 'write' });
    for (const job of [jobs.pending, jobs.tag]) {
      expect(job?.steps.filter((candidate) => candidate.uses !== undefined)).toEqual([]);
    }
  });

  test('tag waits for the pre-check build and dispatches at the tag', () => {
    expect(jobs.tag?.needs).toContain('build');
    const script = jobs.tag?.steps.map((candidate) => candidate.run ?? '').join('\n') ?? '';
    expect(script).toContain(
      'gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG" -f tag="$TAG"'
    );
  });

  test('publish never runs on the push to main', () => {
    expect(jobs.publish?.if).toContain(
      "!(github.event_name == 'push' && github.ref_type == 'branch')"
    );
  });

  test('quality and build run the pre-check only for a pending version', () => {
    expect(jobs.quality?.if).toContain(
      "needs.pending.result == 'skipped' || needs.pending.outputs.due == 'true'"
    );
    expect(jobs.build?.if).toContain("needs.quality.result == 'success'");
  });

  test('build picks the tag gate or the untagged-commit gate', () => {
    expect(step(jobs.build, 'Verify tag (gate)')?.if).toBe(`\${{ !needs.pending.outputs.tag }}`);
    expect(step(jobs.build, 'Verify untagged main commit (gate)')?.if).toBe(
      `\${{ needs.pending.outputs.tag }}`
    );
  });
});
