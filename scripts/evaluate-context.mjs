import { build } from 'esbuild'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const allowed = new Set(['--output', '--iterations', '--model', '--model-budget-ms'])
const values = new Map()
for (let index = 0; index < args.length; index += 2) {
  if (!allowed.has(args[index]) || !args[index + 1] || values.has(args[index])) throw new Error('Usage: node scripts/evaluate-context.mjs [--output report.json] [--iterations 1..20] [--model /absolute/local-pack.json] [--model-budget-ms 1000..120000]')
  values.set(args[index], args[index + 1])
}
const output = values.get('--output') ?? 'test-results/context-evaluation.json'
const iterations = Number(values.get('--iterations') ?? 3)
const modelPath = values.get('--model')
const semanticBudgetMs = Number(values.get('--model-budget-ms') ?? 60000)
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20 || !Number.isInteger(semanticBudgetMs) || semanticBudgetMs < 1000 || semanticBudgetMs > 120000 || (modelPath && !path.isAbsolute(modelPath))) throw new Error('Evaluation iterations, model path or model time budget is invalid.')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'workstack-evaluation-runner-'))
try {
  const worker = path.join(temporary, 'runner.cjs')
  await build({ entryPoints: [path.resolve('tests/support/context-evaluation-runner.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
  const entry = path.join(temporary, 'entry.cjs')
  await writeFile(entry, `const {runContextEvaluation}=require(${JSON.stringify(worker)});runContextEvaluation(${JSON.stringify({iterations,modelPath,semanticBudgetMs})}).then(report=>{process.stdout.write(JSON.stringify(report));if(!report.gates.passed)process.exitCode=1}).catch(error=>{process.stderr.write(String(error.stack||error));process.exitCode=2});`)
  const child = spawn(process.execPath, [entry], { env: { ...process.env, NODE_PATH: path.resolve('node_modules') }, stdio: ['ignore', 'pipe', 'inherit'] })
  let text = ''
  child.stdout.on('data', (data) => { text += data.toString() })
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  if (text) {
    const report = JSON.parse(text)
    await mkdir(path.dirname(path.resolve(output)), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${report.gates.passed ? 'PASS' : 'FAIL'}: ${report.scores.length} case/stage results; ${report.index.sources} sources; report ${path.resolve(output)}\n`)
    for (const failure of report.gates.violations) process.stdout.write(`- ${failure}\n`)
  }
  process.exitCode = Number(exitCode ?? 2)
} finally { await rm(temporary, { recursive: true, force: true }) }
