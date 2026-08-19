// This file scans source text at build/test time rather than running in the
// browser-like renderer context every other file here does, so it needs
// Node's fs/path — genuinely unlike any other file under renderer/src/.
// tsconfig.web.json deliberately has no Node types (matching
// `nodeIntegration: false`), so this file is excluded there and instead
// included directly in tsconfig.node.json's `include` list, which already
// has them. Its actual runtime location is unaffected — it still ships
// nowhere and only ever runs under vitest.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Non-negotiable #1 is the most safety-critical rule in this project:
 * Explore mode never displays significance claims. It already has three
 * structural guards — the `renderer/src/analyze/**` directory boundary,
 * `useAnalysisStore.ts` being the only place an `AnalysisResult` is held,
 * and an ESLint `no-restricted-imports` rule scoped to the Explore
 * directories (`eslint.config.js`). This is the fourth: a scan a linter
 * can't do, catching the case where someone types a p-value into JSX by
 * hand rather than importing one.
 *
 * This project already pins conventions exactly this way elsewhere — see
 * `space-weather.ts`'s test asserting `KP_STORM_THRESHOLD` is declared
 * independently of H4c's registered trigger — so a source-scanning test
 * reads as idiomatic here, not paranoid.
 */

const EXPLORE_DIRS = ['panels', 'layers', 'globe', 'state'];
const RENDERER_SRC = join(__dirname, '..');

// Precise signals only. An earlier draft also matched bare "correlation" and
// "significan(t/ce)" — and immediately found two permanent false positives
// in real code: `event.significance` is USGS's own field name (nothing to
// do with statistics), and AntipodalSection.tsx's own doc comment *quotes*
// "p = 0.03" while explaining why Explore doesn't print one. Both are
// legitimate. The patterns below target actual rendered values and
// identifiers, which those false positives are not.
const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'pValue identifier', pattern: /\bpValue\b/ },
  { name: 'pAdjusted* identifier', pattern: /\bpAdjusted\w*\b/ },
  { name: 'a rendered p-value literal (e.g. "p = 0.03", "p < 0.05")', pattern: /\bp\s*[=<]\s*0?\.\d/ },
];

/** Removes comments before scanning — see the note above on why a literal
 * scan without this produces false positives on legitimate design-rationale
 * prose that quotes the very pattern it's explaining the app doesn't do. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function exploreFiles(): string[] {
  return EXPLORE_DIRS.flatMap((dirName) => collectSourceFiles(join(RENDERER_SRC, dirName)));
}

describe('Explore/Analyze structural separation', () => {
  it('no Explore-directory file imports from analyze/', () => {
    const offenders = exploreFiles().filter((file) => {
      const content = readFileSync(file, 'utf-8');
      return /from\s+['"][./]*analyze\//.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it('no Explore-directory file contains a p-value identifier or a rendered p-value literal', () => {
    const offenders: { file: string; found: string }[] = [];
    for (const file of exploreFiles()) {
      const content = stripComments(readFileSync(file, 'utf-8'));
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) offenders.push({ file, found: name });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity check: the scan actually finds files (guards against an empty/broken glob)', () => {
    expect(exploreFiles().length).toBeGreaterThan(20);
  });
});
