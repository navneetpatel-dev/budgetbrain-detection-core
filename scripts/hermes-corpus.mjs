/* global process, console */
/**
 * Runs the golden corpus inside the Hermes JS engine (plan T3.1: the pipeline "runs unchanged in
 * Node and Hermes"). Uses the standalone Hermes CLI 0.12, older and stricter than the Hermes in
 * React Native 0.85: no classes (transpiled by Babel, as React Native does), no TextEncoder.
 *
 *   npm run build && npm run corpus:hermes
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';

const ROOT = join(import.meta.dirname, '..');
const platform = { linux: 'linux64-bin', darwin: 'osx-bin', win32: 'win64-bin' }[process.platform];
const hermes = join(ROOT, 'node_modules/hermes-engine-cli', platform, process.platform === 'win32' ? 'hermes.exe' : 'hermes');

const cases = readdirSync(join(ROOT, 'corpus/IN')).flatMap((file) => JSON.parse(readFileSync(join(ROOT, 'corpus/IN', file), 'utf8')));
const result = await build({
  entryPoints: [join(ROOT, 'scripts/hermes/corpus-entry.js')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2019',
  logLevel: 'error',
  plugins: [
    {
      name: 'virtual-corpus',
      setup(b) {
        b.onResolve({ filter: /^virtual:corpus$/ }, () => ({ path: 'corpus', namespace: 'virtual' }));
        b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: JSON.stringify(cases), loader: 'json' }));
      },
    },
  ],
});
const es5 = transformSync(result.outputFiles[0].text, { babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-classes'] }).code;
const file = join(mkdtempSync(join(tmpdir(), 'hermes-corpus-')), 'bundle.js');
writeFileSync(file, es5);

const output = execFileSync(hermes, [file], { encoding: 'utf8' }).trim().split('\n').pop();
const { pass, failures, perMessageMs, verifyError, verifyMs } = JSON.parse(output);
console.log(`Hermes corpus: ${pass}/${cases.length} passing, ${perMessageMs.toFixed(3)} ms/message (interpreter).`);
for (const line of failures) console.error(`  - ${line}`);
console.log(verifyError ? `Hermes pack signature check failed: ${verifyError}` : `Hermes pack signature check: verified in ${verifyMs} ms.`);
if (failures.length > 0 || verifyError) process.exit(1);
