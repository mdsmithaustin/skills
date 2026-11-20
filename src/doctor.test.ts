import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestHomeEnvironment, runCli } from './test-utils.ts';

describe('skills doctor', () => {
  let sandbox: string;
  let project: string;
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'skills-doctor-')));
    project = join(sandbox, 'project');
    home = join(sandbox, 'home');
    env = createTestHomeEnvironment(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'));
    mkdirSync(project);
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  function writeSkill(directory: string, name: string, description: string, extra = '') {
    mkdirSync(directory, { recursive: true });
    const manifest = join(directory, 'SKILL.md');
    writeFileSync(
      manifest,
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\n\nFollow the skill.\n`
    );
    return manifest;
  }

  function addFixture(name: string, description: string, ...args: string[]) {
    const source = join(sandbox, name);
    writeSkill(source, name, description);
    const result = runCli(['add', source, '--yes', '--json', ...args], project, env);
    expect(result.exitCode, result.stderr).toBe(0);
  }

  function doctor(agent: string, ...args: string[]) {
    const result = runCli(['doctor', '--agent', agent, '--json', ...args], project, env);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  }

  it('explains a listed skill differently for the verified Codex and Claude Code loaders', () => {
    addFixture('listed-skill', 'a'.repeat(1100), '--agent', 'codex', 'claude-code');
    const listed = runCli(['list', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'listed-skill' })])
    );

    const path = join(project, '.agents/skills/listed-skill/SKILL.md');
    const original = readFileSync(path);
    const codex = doctor('codex', '--agent-version', '0.166.0');
    expect(codex.findings).toEqual([
      expect.objectContaining({
        ruleId: 'description-too-long',
        path,
        problem: expect.stringContaining('1100'),
        effect: 'description_shortened',
        fix: 'Shorten description to 1024 code points or fewer.',
        verifiedVersion: '0.166.0',
      }),
    ]);
    const claude = doctor('claude-code', '--agent-version', '2.1.316');
    expect(claude.profile).toMatchObject({ status: 'verified', verifiedVersion: '2.1.316' });
    expect(claude.findings).toEqual([]);

    const text = runCli(['doctor', '-a', 'codex'], project, env);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain('description-too-long');
    expect(text.stdout).toContain(path);
    expect(text.stdout).toContain('description shortened (codex 0.166.0)');
    expect(text.stdout).toContain(codex.findings[0].fix);
    expect(readFileSync(path)).toEqual(original);

    writeSkill(join(project, '.agents/skills/listed-skill'), 'listed-skill', 'a'.repeat(1024));
    expect(doctor('codex').findings).toEqual([]);
  });

  it('checks healthy global copies and project links in the selected scope', () => {
    addFixture('global-copy', 'Use a copy.', '--agent', 'claude-code', '--global', '--copy');
    addFixture('project-link', 'Use a link.', '--agent', 'codex', 'claude-code');
    const copy = join(home, '.claude/skills/global-copy');
    const link = join(project, '.claude/skills/project-link');
    expect(lstatSync(copy).isDirectory()).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const target = readlinkSync(link);
    expect(doctor('claude-code')).toMatchObject({ scope: 'project', findings: [] });
    expect(doctor('claude-code', '--global')).toMatchObject({ scope: 'global', findings: [] });
    expect(readlinkSync(link)).toBe(target);
  });

  it('reports broken links and links to files without changing them', () => {
    const root = join(project, '.claude/skills');
    mkdirSync(root, { recursive: true });
    const broken = join(root, 'missing-target');
    const wrongType = join(root, 'file-target');
    const target = join(sandbox, 'deleted-skill');
    symlinkSync(target, broken, 'junction');
    const manifest = writeSkill(join(sandbox, 'link-source'), 'link-source', 'Use this skill.');
    if (process.platform !== 'win32') symlinkSync(manifest, wrongType);
    const findings = doctor('claude-code').findings;
    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'directory-link-broken',
        path: broken,
        effect: 'not_loaded',
        verifiedVersion: '2.1.316',
      })
    );
    if (process.platform !== 'win32') {
      expect(findings).toContainEqual(
        expect.objectContaining({ ruleId: 'directory-link-target', path: wrongType })
      );
    }
    expect(lstatSync(broken).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(doctor('claude-code', '-g').findings).toEqual([]);
  });

  it('distinguishes exact manifest casing and a missing agent path', () => {
    addFixture('codex-only', 'Available from the shared directory.', '--agent', 'codex');
    expect(doctor('claude-code').findings).toEqual([
      expect.objectContaining({
        ruleId: 'agent-path-missing',
        path: join(project, '.agents/skills/codex-only'),
        effect: 'not_loaded',
        fix: expect.stringContaining('--agent claude-code'),
      }),
    ]);

    const directory = join(project, '.agents/skills/codex-only');
    const manifest = join(directory, 'SKILL.md');
    const wrongCase = join(directory, 'Skill.md');
    renameSync(manifest, join(directory, 'renaming'));
    renameSync(join(directory, 'renaming'), wrongCase);
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({
        ruleId: 'manifest-casing',
        path: wrongCase,
        effect: 'not_loaded',
        verifiedVersion: '0.166.0',
      }),
    ]);
  });

  it('reports duplicate names for distinct installed copies', () => {
    const root = join(project, '.agents/skills');
    const first = join(root, 'first');
    const second = join(root, 'second');
    writeSkill(first, 'same-name', 'Use the first skill.');
    writeSkill(second, 'same-name', 'Use the second skill.');
    const findings = doctor('codex').findings;
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'duplicate-name',
        path: first,
        problem: expect.stringContaining(second),
        effect: 'duplicate_listed',
      }),
      expect.objectContaining({
        ruleId: 'duplicate-name',
        path: second,
        problem: expect.stringContaining(first),
        effect: 'duplicate_listed',
      }),
    ]);
  });

  it('uses code points and includes when_to_use in the Claude Code limit', () => {
    const codex = join(project, '.agents/skills/unicode');
    writeSkill(codex, 'unicode', '🌵'.repeat(1024));
    expect(doctor('codex').findings).toEqual([]);
    writeSkill(codex, 'unicode', '🌵'.repeat(1025));
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({
        ruleId: 'description-too-long',
        problem: expect.stringContaining('1025'),
      }),
    ]);

    const claude = join(project, '.claude/skills/unicode');
    writeSkill(claude, 'unicode', 'a'.repeat(1024), `when_to_use: ${'b'.repeat(511)}\n`);
    expect(doctor('claude-code').findings).toEqual([]);
    writeSkill(claude, 'unicode', 'a'.repeat(1024), `when_to_use: ${'b'.repeat(512)}\n`);
    expect(doctor('claude-code').findings).toEqual([
      expect.objectContaining({
        ruleId: 'description-too-long',
        problem: expect.stringContaining('1537'),
        verifiedVersion: '2.1.316',
      }),
    ]);
  });

  it('keeps filesystem findings and marks unverified effects unknown', () => {
    const claude = join(project, '.claude/skills/incomplete');
    const windsurf = join(project, '.windsurf/skills/incomplete');
    mkdirSync(claude, { recursive: true });
    mkdirSync(windsurf, { recursive: true });
    const unknown = doctor('claude-code', '--agent-version', '2.1.327');
    expect(unknown.profile).toMatchObject({ status: 'unknown', version: '2.1.327' });
    expect(unknown.findings).toEqual([
      expect.objectContaining({
        ruleId: 'manifest-missing',
        path: claude,
        effect: 'unknown',
        verifiedVersion: null,
      }),
    ]);
    expect(doctor('windsurf')).toMatchObject({
      profile: { status: 'unknown', version: null },
      findings: [{ ruleId: 'manifest-missing', path: windsurf, effect: 'unknown' }],
    });
  });
  it('finds a missing Codex installation for a copy listed under another agent', () => {
    addFixture('claude-only', 'Use this skill.', '--agent', 'claude-code', '--copy');
    const listed = runCli(['list', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const path = join(project, '.claude/skills/claude-only');
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'claude-only', path })])
    );
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({
        ruleId: 'agent-path-missing',
        path,
        effect: 'not_loaded',
        fix: expect.stringContaining('--agent codex'),
      }),
    ]);
    expect(doctor('claude-code').findings).toEqual([]);
  });

  it('checks the manifest name of a matching Claude Code directory link', () => {
    addFixture('expected', 'Use this skill.', '--agent', 'codex', 'claude-code');
    const link = join(project, '.claude/skills/expected');
    const foreign = join(sandbox, 'foreign');
    writeSkill(foreign, 'different-skill', 'Use a different skill.');
    rmSync(link);
    symlinkSync(foreign, link, 'junction');
    expect(doctor('claude-code').findings).toEqual([
      expect.objectContaining({
        ruleId: 'agent-path-missing',
        path: join(project, '.agents/skills/expected'),
        effect: 'not_loaded',
      }),
    ]);
  });

  it('checks visible Codex manifests through depth six, including nested skills', () => {
    const root = join(project, '.agents/skills');
    const group = join(root, 'group');
    const atLimit = writeSkill(join(group, 'd2/d3/d4/d5/d6'), 'at-limit', 'a'.repeat(1025));
    writeSkill(join(group, 'd2/d3/d4/d5/d6/d7'), 'too-deep', 'a'.repeat(1025));
    writeSkill(join(root, '.hidden'), 'hidden', 'a'.repeat(1025));
    writeSkill(join(group, 'parent'), 'parent', 'Use parent.');
    const nested = writeSkill(join(group, 'parent/child'), 'child', 'a'.repeat(1025));
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({ ruleId: 'description-too-long', path: atLimit }),
      expect.objectContaining({ ruleId: 'description-too-long', path: nested }),
      expect.objectContaining({
        ruleId: 'directory-hidden',
        path: join(root, '.hidden'),
        effect: 'not_loaded',
      }),
    ]);
  });

  it('reports a distinct global Claude Code copy only on the shadowed project path', () => {
    addFixture('same-skill', 'Use this skill.', '--agent', 'claude-code', '--copy');
    addFixture(
      'same-skill',
      'Use the global skill.',
      '--agent',
      'claude-code',
      '--global',
      '--copy'
    );
    const path = join(project, '.claude/skills/same-skill');
    const globalPath = join(home, '.claude/skills/same-skill');
    expect(doctor('claude-code').findings).toEqual([
      expect.objectContaining({
        ruleId: 'global-name-shadow',
        path,
        problem: expect.stringContaining(globalPath),
        effect: 'shadowed_by_global',
        verifiedVersion: '2.1.316',
      }),
    ]);
    expect(doctor('claude-code', '--global').findings).toEqual([]);
    expect(doctor('claude-code', '--agent-version', '2.1.327').findings).toEqual([
      expect.objectContaining({
        ruleId: 'global-name-shadow',
        path,
        effect: 'unknown',
        verifiedVersion: null,
      }),
    ]);

    rmSync(path, { recursive: true });
    symlinkSync(globalPath, path, 'junction');
    expect(doctor('claude-code').findings).toEqual([]);
  });

  it('does not predict a load failure for a broken link outside the active Claude Code root', () => {
    addFixture('healthy-copy', 'Use this skill.', '--agent', 'claude-code', '--copy');
    const shared = join(project, '.agents/skills');
    mkdirSync(shared, { recursive: true });
    const path = join(shared, 'healthy-copy');
    symlinkSync(join(sandbox, 'absent'), path, 'junction');
    expect(doctor('claude-code').findings).toEqual([
      expect.objectContaining({
        ruleId: 'directory-link-broken',
        path,
        effect: 'unknown',
        verifiedVersion: null,
      }),
    ]);
  });

  it('reports a broken nested Codex link beside a loadable skill', () => {
    const group = join(project, '.agents/skills/group');
    writeSkill(join(group, 'healthy'), 'healthy', 'Use this skill.');
    const path = join(group, 'broken');
    const target = join(sandbox, 'target');
    writeSkill(target, 'target', 'Use the linked skill.');
    symlinkSync(target, path, 'junction');
    expect(doctor('codex').findings).toEqual([]);
    rmSync(target, { recursive: true });
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({
        ruleId: 'directory-link-broken',
        path,
        effect: 'not_loaded',
        verifiedVersion: '0.166.0',
      }),
    ]);
  });

  it('reports a deleted tracked Codex manifest when references remain', () => {
    const source = join(sandbox, 'referenced');
    const original = writeSkill(source, 'referenced', 'Use the guide.');
    mkdirSync(join(source, 'references'));
    writeFileSync(join(source, 'references/guide.md'), 'The skill guide.');
    const added = runCli(
      ['add', source, '--agent', 'codex', '--copy', '--yes', '--json'],
      project,
      env
    );
    expect(added.exitCode, added.stderr).toBe(0);
    const path = join(project, '.agents/skills/referenced');
    const manifest = join(path, 'SKILL.md');
    const lock = join(project, 'skills-lock.json');
    const originalLock = readFileSync(lock);
    expect(existsSync(join(path, 'references/guide.md'))).toBe(true);
    rmSync(manifest);
    expect(doctor('codex').findings).toEqual([
      expect.objectContaining({ ruleId: 'manifest-missing', path, effect: 'not_loaded' }),
    ]);
    expect(readFileSync(lock)).toEqual(originalLock);
    writeFileSync(manifest, readFileSync(original));
    expect(doctor('codex').findings).toEqual([]);
  });

  it('reports distinct Codex copies across project and global scopes', () => {
    addFixture('duplicate', 'Use the project skill.', '--agent', 'codex', '--copy');
    addFixture('duplicate', 'Use the global skill.', '--agent', 'codex', '--global', '--copy');
    const path = join(project, '.agents/skills/duplicate');
    const globalPath = join(home, '.agents/skills/duplicate');
    expect(doctor('codex', '--agent-version', '0.166.0').findings).toEqual([
      expect.objectContaining({
        ruleId: 'duplicate-name',
        path,
        problem: expect.stringContaining(globalPath),
        effect: 'duplicate_listed',
        verifiedVersion: '0.166.0',
      }),
    ]);
    expect(doctor('codex', '--global', '--agent-version', '0.166.0').findings).toEqual([
      expect.objectContaining({
        ruleId: 'duplicate-name',
        path: globalPath,
        problem: expect.stringContaining(path),
        effect: 'duplicate_listed',
      }),
    ]);
    rmSync(path, { recursive: true });
    symlinkSync(globalPath, path, 'junction');
    expect(doctor('codex').findings).toEqual([]);
    expect(doctor('codex', '--global').findings).toEqual([]);
  });

  it('reports that a listed UTF-8 BOM manifest is rejected by Codex', () => {
    const source = join(sandbox, 'with-bom');
    const original = writeSkill(source, 'with-bom', 'Use this skill.');
    writeFileSync(original, '\uFEFF' + readFileSync(original, 'utf8'));
    const added = runCli(
      ['add', source, '--agent', 'codex', 'claude-code', '--yes', '--json'],
      project,
      env
    );
    expect(added.exitCode, added.stderr).toBe(0);
    const listed = runCli(['list', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'with-bom', status: 'tracked' })])
    );

    const path = join(project, '.agents/skills/with-bom/SKILL.md');
    expect(doctor('codex', '--agent-version', '0.166.0').findings).toEqual([
      expect.objectContaining({
        ruleId: 'manifest-bom',
        path,
        effect: 'not_loaded',
        verifiedVersion: '0.166.0',
      }),
    ]);
    expect(doctor('codex', '--agent-version', '0.170.0').findings).toEqual([
      expect.objectContaining({ ruleId: 'manifest-bom', effect: 'unknown' }),
    ]);
    expect(doctor('claude-code').findings).toEqual([]);
    writeFileSync(path, readFileSync(path, 'utf8').slice(1));
    expect(doctor('codex').findings).toEqual([]);
  });

  it('leaves a healthy Eve subagent-only skill at unknown loader compatibility', () => {
    mkdirSync(join(project, 'agent/subagents/research'), { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { eve: '0.11.5' } })
    );
    addFixture(
      'research-skill',
      'Use this skill.',
      '--agent',
      'eve',
      '--subagent',
      'research',
      '--copy'
    );
    const path = join(project, 'agent/subagents/research/skills/research-skill');
    expect(existsSync(join(path, 'SKILL.md'))).toBe(true);
    const listed = runCli(['list', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'research-skill', path })])
    );
    expect(doctor('eve')).toMatchObject({ profile: { status: 'unknown' }, findings: [] });
  });
});
