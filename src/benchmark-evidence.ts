import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { listInstalledSkills } from './installer.ts';
import { sanitizeMetadata } from './sanitize.ts';

const DIGEST_SCHEME = 'skill-tree-sha256-v2';
const USAGE = 'Usage: skills evidence <skill> <benchmark-evidence.json> [-g] [--json]';
const SHA256 = /^[a-f0-9]{64}$/;

const unknownReasons = {
  unsupported_schema: 'The evidence schema version is unsupported.',
  missing_skill_identity: 'The evidence has no recorded digest for this skill.',
  ambiguous_skill_identity: 'The evidence has multiple entries for this skill.',
  unsupported_digest_scheme: 'The recorded digest scheme is unsupported.',
  invalid_skill_digest: 'The recorded skill digest is invalid.',
  skill_not_installed: 'The skill was not found in the selected scope.',
  unverifiable_skill_tree: 'The installed skill contains an unreadable or unsupported entry.',
};

type IdentityReason = keyof typeof unknownReasons;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function caseCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function liftInterval(value: unknown) {
  if (!isRecord(value)) return null;
  const lower = numberOrNull(value.lower);
  const upper = numberOrNull(value.upper);
  const confidence = numberOrNull(value.confidence);
  const method = stringOrNull(value.method);
  return lower === null || upper === null || confidence === null || method === null
    ? null
    : { lower, upper, confidence, method };
}

function localPath(input: string): string {
  if (/^file:/i.test(input)) {
    const url = new URL(input);
    if (!url.hostname) return fileURLToPath(url);
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    if (process.platform !== 'win32' || !/^[\\/]{2}/.test(input)) return input;
  }
  throw new Error('Benchmark evidence must be a local path or a local file URL.');
}

async function readEvidence(input: string) {
  const path = localPath(input);
  if (!(await stat(path)).isFile()) {
    throw new Error('Benchmark evidence must be a regular JSON file.');
  }
  const card: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(card)) throw new Error('Benchmark evidence must contain a JSON object.');
  return card;
}

async function skillTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const length = Buffer.alloc(8);

  async function hashDirectory(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true, encoding: 'buffer' });
    entries.sort((a, b) => Buffer.compare(a.name, b.name));
    for (const entry of entries) {
      const name = utf8.decode(entry.name);
      const path = join(directory, name);
      const relativePath = prefix + name;
      if (entry.isDirectory()) {
        await hashDirectory(path, relativePath + '/');
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash
          .update(relativePath + '\0', 'utf8')
          .update(length)
          .update(bytes);
      } else {
        throw new Error('The digest scheme requires regular files.');
      }
    }
  }

  await hashDirectory(root, '');
  return hash.digest('hex');
}

async function compareSkill(card: Record<string, unknown>, name: string, global: boolean) {
  const members: unknown[] = Array.isArray(card.skills) ? card.skills : [];
  const identities = members.filter(isRecord).filter((member) => member.name === name);
  const member = identities.length === 1 ? identities[0] : undefined;
  const digestScheme = stringOrNull(member?.digest_scheme);
  const recordedDigest = stringOrNull(member?.digest);
  const recorded = { digest_scheme: digestScheme, recorded_digest: recordedDigest };

  function unknown(reason: IdentityReason, installedPath: string | null = null) {
    return {
      status: 'unknown',
      reason,
      ...recorded,
      installed_path: installedPath,
      installed_digest: null,
    } as const;
  }

  if (card.schema_version !== 1) return unknown('unsupported_schema');
  if (identities.length > 1) return unknown('ambiguous_skill_identity');
  if (digestScheme === null || recordedDigest === null) return unknown('missing_skill_identity');
  if (digestScheme !== DIGEST_SCHEME) return unknown('unsupported_digest_scheme');
  if (!SHA256.test(recordedDigest)) return unknown('invalid_skill_digest');

  const installed = await listInstalledSkills({ global });
  const skill = installed.find((candidate) => candidate.name === name);
  if (!skill) return unknown('skill_not_installed');
  const digest = await skillTreeDigest(skill.path).catch(() => null);
  if (digest === null) return unknown('unverifiable_skill_tree', skill.path);
  return {
    status: digest === recordedDigest ? 'match' : 'changed',
    reason: null,
    ...recorded,
    installed_path: skill.path,
    installed_digest: digest,
  } as const;
}

export async function runBenchmarkEvidence(args: string[]): Promise<void> {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        global: { type: 'boolean', short: 'g', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const [skillName, input] = positionals;
    if (!skillName || !input || positionals.length !== 2) throw new Error(USAGE);

    const card = await readEvidence(input);
    const evidence = card.schema_version === 1 ? card : undefined;
    const cases = isRecord(evidence?.coverage) ? evidence.coverage : undefined;
    const report = {
      schema_version: 1,
      evidence_schema_version: caseCount(card.schema_version),
      skill_name: skillName,
      scope: values.global ? 'global' : 'project',
      identity: await compareSkill(card, skillName, values.global),
      benchmark: {
        skill_name: stringOrNull(evidence?.skill_name),
        dataset_digest: stringOrNull(evidence?.dataset_digest),
        agent: stringOrNull(evidence?.agent),
        model: stringOrNull(evidence?.model),
        baseline_outcome_rate: numberOrNull(evidence?.baseline_outcome_rate),
        with_skill_outcome_rate: numberOrNull(evidence?.with_skill_outcome_rate),
        lift_interval: liftInterval(evidence?.lift_interval),
        coverage: {
          complete_cases: caseCount(cases?.complete_cases),
          planned_cases: caseCount(cases?.planned_cases),
        },
      },
    };
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const { identity, benchmark } = report;
    const percent = new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const points = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
    const rate = (value: number | null) => (value === null ? 'unknown' : percent.format(value));
    const label = (value: string | null) => sanitizeMetadata(value ?? '') || 'unknown';
    console.log(`Benchmark evidence for ${label(skillName)} (${report.scope})`);
    console.log(`Skill revision: ${identity.status}`);
    if (identity.reason) console.log(unknownReasons[identity.reason]);
    if (identity.installed_path) console.log(`Installed path: ${label(identity.installed_path)}`);
    console.log(`Run: ${label(benchmark.skill_name)}`);
    console.log(`Dataset: ${label(benchmark.dataset_digest)}`);
    console.log(`Agent: ${label(benchmark.agent)}`);
    console.log(`Model: ${label(benchmark.model)}`);
    console.log(`Baseline outcome: ${rate(benchmark.baseline_outcome_rate)}`);
    console.log(`With-skill outcome: ${rate(benchmark.with_skill_outcome_rate)}`);
    const interval = benchmark.lift_interval;
    if (interval) {
      console.log(
        `Lift interval (${rate(interval.confidence)}, ${label(interval.method)}): ${points.format(interval.lower * 100)} to ${points.format(interval.upper * 100)} percentage points`
      );
    } else {
      console.log('Lift interval: unavailable');
    }
    const { complete_cases: complete, planned_cases: planned } = benchmark.coverage;
    console.log(`Cases: ${complete ?? 'unknown'} of ${planned ?? 'unknown'} complete`);
  } catch (error) {
    console.error(
      `Error: ${sanitizeMetadata(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
  }
}
