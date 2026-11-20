import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestHomeEnvironment, runCli } from './test-utils.ts';

const fixture = join(import.meta.dirname, '../tests/fixtures/benchmark-evidence');
const exportedCard = join(fixture, 'benchmark-evidence.json');
const digest = '254b652604373da2e54ba8c665b0e8ae88e93819e8d6d6c428891d4f175934dc';
const name = 'materialize-demo';

describe('skills evidence', () => {
  let sandbox: string;
  let project: string;
  let env: Record<string, string>;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'skills-evidence-'));
    project = join(sandbox, 'project');
    mkdirSync(project);
    env = createTestHomeEnvironment(join(sandbox, 'home'));
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  function inspect(file = exportedCard, ...args: string[]) {
    const result = runCli(['evidence', name, file, '--json', ...args], project, env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  }

  it('checks an installed skill against the exported card and detects a reference-only edit', () => {
    const source = join(sandbox, 'renamed');
    cpSync(join(fixture, name), source, { recursive: true });
    const installed = runCli(['add', source, '-y', '-a', 'codex', '--json'], project, env);
    expect(installed.exitCode, installed.stderr).toBe(0);
    const listed = runCli(['list', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const [skill] = JSON.parse(listed.stdout);
    expect(skill.name).toBe(name);

    const before = inspect();
    expect(before).toEqual({
      schema_version: 1,
      evidence_schema_version: 1,
      skill_name: name,
      scope: 'project',
      identity: {
        status: 'match',
        reason: null,
        installed_path: skill.path,
        digest_scheme: 'skill-tree-sha256-v2',
        recorded_digest: digest,
        installed_digest: digest,
      },
      benchmark: {
        skill_name: 'materialize-bench',
        dataset_digest: 'sha256:71e22dde03375ffea25f3d1ca97d3b72529f3382c244a094b5def66a4a4d2f7d',
        agent: 'codex',
        model: 'offline-model',
        baseline_outcome_rate: 0,
        with_skill_outcome_rate: 1,
        lift_interval: null,
        coverage: { complete_cases: 2, planned_cases: 2 },
      },
    });
    expect(inspect(pathToFileURL(exportedCard).href)).toEqual(before);

    const cardBytes = readFileSync(exportedCard);
    const manifest = join(skill.path, 'SKILL.md');
    const manifestBytes = readFileSync(manifest);
    const reference = join(skill.path, 'references/label.txt');
    writeFileSync(reference, 'Edited label\n');
    const after = inspect();
    expect(after.identity).toMatchObject({
      status: 'changed',
      reason: null,
      recorded_digest: digest,
    });
    expect(after.identity.installed_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(after.identity.installed_digest).not.toBe(digest);
    expect(after.benchmark).toEqual(before.benchmark);
    expect(readFileSync(exportedCard)).toEqual(cardBytes);
    expect(readFileSync(manifest)).toEqual(manifestBytes);
    expect(readFileSync(reference, 'utf8')).toBe('Edited label\n');

    const text = runCli(['evidence', name, exportedCard], project, env);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain('Skill revision: changed');
    expect(text.stdout).toContain('Agent: codex\nModel: offline-model');
    expect(text.stdout).toContain('Baseline outcome: 0.00%\nWith-skill outcome: 100.00%');
    expect(text.stdout).toContain('Cases: 2 of 2 complete');
  });

  it('uses the selected scope and follows an installed-directory link only at the root', () => {
    const source = join(sandbox, 'global-source');
    cpSync(join(fixture, name), source, { recursive: true });
    const globalRoot = join(env.HOME!, '.agents', 'skills');
    mkdirSync(globalRoot, { recursive: true });
    symlinkSync(source, join(globalRoot, 'renamed'), 'junction');

    expect(inspect()).toMatchObject({
      scope: 'project',
      identity: { status: 'unknown', reason: 'skill_not_installed' },
    });
    expect(inspect(undefined, '-g')).toMatchObject({
      scope: 'global',
      identity: { status: 'match', installed_digest: digest },
    });

    symlinkSync(join(source, 'references'), join(source, 'linked-references'), 'junction');
    expect(inspect(undefined, '--global')).toMatchObject({
      scope: 'global',
      identity: { status: 'unknown', reason: 'unverifiable_skill_tree', installed_digest: null },
    });
  });

  it.each([
    [
      'unsupported digest scheme',
      { digest_scheme: 'skill-tree-sha256-v1' },
      'unsupported_digest_scheme',
    ],
    ['legacy digest', { digest_scheme: null, digest: null }, 'missing_skill_identity'],
    ['malformed digest', { digest: '1234' }, 'invalid_skill_digest'],
    ['unrelated skill', { name: 'materialize-bench' }, 'missing_skill_identity'],
  ])('reports unknown for %s and preserves the outcomes', (_description, overrides, reason) => {
    const card = JSON.parse(readFileSync(exportedCard, 'utf8'));
    const cardPath = join(sandbox, 'card.json');
    Object.assign(card.skills[0], overrides);
    writeFileSync(cardPath, JSON.stringify(card));
    expect(inspect(cardPath)).toMatchObject({
      identity: { status: 'unknown', reason, installed_digest: null },
      benchmark: { model: 'offline-model', baseline_outcome_rate: 0, with_skill_outcome_rate: 1 },
    });
  });

  it('keeps the reported lift interval and marks a new schema as unknown', () => {
    const card = JSON.parse(readFileSync(exportedCard, 'utf8'));
    const cardPath = join(sandbox, 'card.json');
    card.lift_interval = { lower: -0.2, upper: 0.3, confidence: 0.95, method: 'paired bootstrap' };
    writeFileSync(cardPath, JSON.stringify(card));
    expect(inspect(cardPath).benchmark.lift_interval).toEqual(card.lift_interval);
    const text = runCli(['evidence', name, cardPath], project, env);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain(
      'Lift interval (95.00%, paired bootstrap): -20 to 30 percentage points'
    );

    card.schema_version = 2;
    writeFileSync(cardPath, JSON.stringify(card));
    expect(inspect(cardPath)).toMatchObject({
      evidence_schema_version: 2,
      identity: { status: 'unknown', reason: 'unsupported_schema', installed_digest: null },
    });
  });

  it('rejects remote evidence and malformed JSON without a comparison', () => {
    const remote = runCli(
      ['evidence', name, 'https://example.invalid/evidence.json'],
      project,
      env
    );
    expect(remote.exitCode).toBe(1);
    expect(remote.stderr).toContain('Benchmark evidence must be a local path or a local file URL.');
    expect(remote.stdout).toBe('');

    const broken = join(sandbox, 'invalid.json');
    writeFileSync(broken, '{');
    const invalid = runCli(['evidence', name, broken, '--json'], project, env);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('JSON');
    expect(invalid.stdout).toBe('');
  });
});
