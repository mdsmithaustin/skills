import { lstat, readdir, readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { agents } from './agents.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { getAgentBaseDir, getCanonicalSkillsDir, sanitizeName } from './installer.ts';
import { sanitizeMetadata } from './sanitize.ts';
import type { AgentType } from './types.ts';

const profiles = {
  codex: { version: '0.166.0', descriptionLimit: 1024 },
  'claude-code': { version: '2.1.316', descriptionLimit: 1536 },
};

type ProfileAgent = keyof typeof profiles;
type Effect =
  | 'not_loaded'
  | 'loads_on_case_insensitive_filesystem'
  | 'description_shortened'
  | 'description_fallback'
  | 'duplicate_listed'
  | 'name_conflict';
type RuleId =
  | 'install-root-unreadable'
  | 'agent-path-missing'
  | 'directory-link-broken'
  | 'directory-link-target'
  | 'skill-directory-unreadable'
  | 'manifest-missing'
  | 'manifest-casing'
  | 'manifest-invalid'
  | 'manifest-link'
  | 'description-missing'
  | 'description-too-long'
  | 'duplicate-name';

interface Finding {
  ruleId: RuleId;
  path: string;
  problem: string;
  effect: Effect | 'unknown';
  fix: string;
  verifiedVersion: string | null;
}

interface SkillDirectory {
  path: string;
  folder: string;
  name?: string;
  identity?: string;
}

function isAgent(value: string): value is AgentType {
  return Object.hasOwn(agents, value);
}

function isProfileAgent(agent: AgentType): agent is ProfileAgent {
  return agent === 'codex' || agent === 'claude-code';
}

function fileError(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
}

async function inspectInstallation(agent: AgentType, global: boolean, requestedVersion?: string) {
  const profile = isProfileAgent(agent) ? profiles[agent] : undefined;
  const version = requestedVersion ?? profile?.version ?? null;
  const verified = profile !== undefined && version === profile.version;
  const canonical = getCanonicalSkillsDir(global);
  const agentRoot =
    !global || agents[agent].globalSkillsDir ? resolve(getAgentBaseDir(agent, global)) : undefined;
  const roots = new Set(agentRoot ? [agentRoot] : []);
  const configuredGlobalRoot = agents[agent].globalSkillsDir;
  if (global && configuredGlobalRoot) roots.add(resolve(configuredGlobalRoot));
  if (agent === 'codex') {
    roots.add(
      global
        ? resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'skills')
        : resolve('.codex/skills')
    );
  }
  const findings: Finding[] = [];

  function addFinding(
    ruleId: RuleId,
    path: string,
    problem: string,
    fix: string,
    predictedEffect?: Effect
  ): void {
    findings.push({
      ruleId,
      path,
      problem,
      effect: verified && predictedEffect ? predictedEffect : 'unknown',
      fix,
      verifiedVersion: verified && predictedEffect ? profile.version : null,
    });
  }

  async function scanRoot(root: string, active: boolean): Promise<SkillDirectory[]> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = fileError(error);
      if (code !== 'ENOENT' || (await lstat(root).catch(() => null))?.isSymbolicLink()) {
        addFinding(
          'install-root-unreadable',
          root,
          `Cannot read the skills directory (${code}).`,
          'Restore a readable skills directory at this path.',
          active && code === 'ENOENT' ? 'not_loaded' : undefined
        );
      }
      return [];
    }

    const directories: SkillDirectory[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      const directory: SkillDirectory = { path, folder: entry.name };
      directories.push(directory);
      if (entry.isSymbolicLink()) {
        try {
          if (!(await stat(path)).isDirectory()) {
            addFinding(
              'directory-link-target',
              path,
              'The skill directory link points to a non-directory.',
              'Point this link to the directory containing SKILL.md.',
              'not_loaded'
            );
            continue;
          }
        } catch (error) {
          const code = fileError(error);
          const broken = ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code);
          addFinding(
            broken ? 'directory-link-broken' : 'skill-directory-unreadable',
            path,
            `Cannot resolve the skill directory link (${code}).`,
            'Restore the target directory or reinstall the skill from its original source.',
            broken ? 'not_loaded' : undefined
          );
          continue;
        }
      }

      let files;
      try {
        files = await readdir(path);
      } catch (error) {
        addFinding(
          'skill-directory-unreadable',
          path,
          `Cannot read the skill directory (${fileError(error)}).`,
          'Restore read access to the skill directory.'
        );
        continue;
      }
      const manifestName = files.includes('SKILL.md')
        ? 'SKILL.md'
        : files.find((file) => file.toLowerCase() === 'skill.md');
      if (!manifestName) {
        if (active) {
          addFinding(
            'manifest-missing',
            path,
            'The directory is missing SKILL.md.',
            'Restore SKILL.md from the original skill source.',
            'not_loaded'
          );
        }
        continue;
      }

      const manifest = join(path, manifestName);
      let canLoad = active;
      if (active && manifestName !== 'SKILL.md') {
        let effect: Effect | undefined;
        if (agent === 'codex') effect = 'not_loaded';
        if (agent === 'claude-code') {
          effect = await stat(join(path, 'SKILL.md')).then(
            () => 'loads_on_case_insensitive_filesystem',
            (error: unknown) => (fileError(error) === 'ENOENT' ? 'not_loaded' : undefined)
          );
        }
        addFinding(
          'manifest-casing',
          manifest,
          `The manifest is named ${manifestName}.`,
          'Rename the file to SKILL.md with that exact casing.',
          effect
        );
        if (verified && effect === 'not_loaded') canLoad = false;
      }

      let data;
      try {
        const entry = await lstat(manifest);
        if (!(entry.isSymbolicLink() ? await stat(manifest) : entry).isFile()) {
          throw new Error('SKILL.md must be a file.');
        }
        if (active && entry.isSymbolicLink() && agent !== 'claude-code') {
          addFinding(
            'manifest-link',
            manifest,
            'SKILL.md is a file link.',
            'Replace the link with a regular copy of SKILL.md.',
            agent === 'codex' ? 'not_loaded' : undefined
          );
          if (verified && agent === 'codex') canLoad = false;
        }
        data = parseFrontmatter(await readFile(manifest, 'utf8')).data;
        directory.identity = await realpath(manifest);
      } catch {
        if (active) {
          addFinding(
            'manifest-invalid',
            manifest,
            'Cannot read SKILL.md as a regular file with valid YAML front matter.',
            'Restore a readable SKILL.md with valid YAML from the original skill source.'
          );
        }
        continue;
      }

      if (typeof data.name === 'string' && data.name.trim()) directory.name = data.name.trim();
      if (!canLoad) {
        if (active) delete directory.identity;
        continue;
      }
      if (typeof data.description !== 'string' || !data.description.trim()) {
        addFinding(
          'description-missing',
          manifest,
          'SKILL.md has no non-empty text description.',
          'Set description to a non-empty string in SKILL.md front matter.',
          agent === 'codex'
            ? 'not_loaded'
            : agent === 'claude-code'
              ? 'description_fallback'
              : undefined
        );
        if (verified && agent === 'codex') delete directory.identity;
        continue;
      }
      if (profile) {
        const use = agent === 'claude-code' ? data.when_to_use : undefined;
        const description = data.description.trim();
        const listing =
          typeof use === 'string' && use.trim() ? `${description} ${use.trim()}` : description;
        const length = [...listing].length;
        if (length > profile.descriptionLimit) {
          addFinding(
            'description-too-long',
            manifest,
            `The listing text has ${length} Unicode code points. The reference profile limits it to ${profile.descriptionLimit}.`,
            `Shorten ${agent === 'claude-code' ? 'description and when_to_use together' : 'description'} to ${profile.descriptionLimit} code points or fewer.`,
            'description_shortened'
          );
        }
      }
    }
    return directories;
  }

  const installed = [];
  for (const root of roots) installed.push(...(await scanRoot(root, true)));
  if (!roots.has(canonical)) {
    for (const directory of await scanRoot(canonical, false)) {
      if (!directory.name || !directory.identity) continue;
      const name = directory.name;
      if (
        installed.some(
          (skill) =>
            skill.folder === directory.folder ||
            skill.folder === sanitizeName(name) ||
            skill.name === name
        )
      )
        continue;
      addFinding(
        'agent-path-missing',
        directory.path,
        `The shared installation has no matching skill at ${agentRoot ?? 'a configured global path'}.`,
        agentRoot
          ? `Install this skill for ${agent} with skills add <original-source> --agent ${agent}${global ? ' --global' : ''}.`
          : 'Install this skill in a project for the selected agent.',
        agent === 'claude-code' ? 'not_loaded' : undefined
      );
    }
  }

  const byName = new Map<string, Map<string, string>>();
  for (const { name, identity, path } of installed) {
    if (!name || !identity) continue;
    const paths = byName.get(name) ?? new Map<string, string>();
    paths.set(identity, path);
    byName.set(name, paths);
  }
  for (const [name, paths] of byName) {
    if (paths.size < 2) continue;
    const locations = [...paths.values()];
    for (const path of locations) {
      addFinding(
        'duplicate-name',
        path,
        `The skill name "${name}" also appears at ${locations.filter((other) => other !== path).join(', ')}.`,
        'Keep one copy or give the skills distinct names and directory names.',
        agent === 'codex'
          ? 'duplicate_listed'
          : agent === 'claude-code'
            ? 'name_conflict'
            : undefined
      );
    }
  }

  return {
    agent,
    scope: global ? 'global' : 'project',
    profile: {
      status: verified ? 'verified' : 'unknown',
      version,
      verifiedVersion: profile?.version ?? null,
    },
    findings,
  };
}

export async function runDoctor(args: string[]): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        agent: { type: 'string', short: 'a' },
        'agent-version': { type: 'string' },
        global: { type: 'boolean', short: 'g' },
        json: { type: 'boolean' },
      },
    }));
  } catch (error) {
    console.error(
      `Error: ${sanitizeMetadata(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
    return;
  }

  if (!values.agent || !isAgent(values.agent)) {
    console.error('Error: skills doctor requires --agent with a supported skills agent name.');
    process.exitCode = 1;
    return;
  }

  const report = await inspectInstallation(
    values.agent,
    values.global ?? false,
    values['agent-version']
  );
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { agent, scope, profile, findings } = report;
  console.log(`Checking ${scope} skills for ${agent}.`);
  if (profile.status === 'verified') {
    console.log(`Predictions use the verified loader version ${profile.version}.`);
  } else {
    console.log(
      `Loader predictions are unknown for ${agent}${profile.version ? ` ${sanitizeMetadata(profile.version)}` : ''}.`
    );
  }
  if (findings.length === 0) console.log('No findings in the inspected skills directories.');
  for (const finding of findings) {
    console.log(
      `\n[${finding.ruleId}] ${sanitizeMetadata(finding.path)}\n` +
        `  ${sanitizeMetadata(finding.problem)}\n` +
        `  Predicted effect: ${finding.effect.replaceAll('_', ' ')}${finding.verifiedVersion ? ` (${agent} ${finding.verifiedVersion})` : ''}\n` +
        `  Fix: ${finding.fix}`
    );
  }
}
