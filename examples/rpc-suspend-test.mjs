// End-to-end test of the durable suspend flow over pi's RPC mode:
//   phase 1: model runs a gated write in the code tool → answer the approval
//            dialog with "Decide later" → suspension → KILL the pi process
//   phase 2: fresh pi process, same session → ask the model to resume →
//            answer "Approve" → script completes → verify the file on disk
//
//   node examples/rpc-suspend-test.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'

const WORK = '/tmp/pi-suspend-e2e'
const SESSIONS = `${WORK}/sessions`
rmSync(WORK, { recursive: true, force: true })
mkdirSync(SESSIONS, { recursive: true })
mkdirSync(`${WORK}/data`, { recursive: true })

const LATER = 'Decide later (suspends the script, resumable any time)'

function runPhase({ continueSession, prompt, dialogAnswer, label }) {
  return new Promise((resolve, reject) => {
    const args = [
      'pi', '--mode', 'rpc', '-ns', '-nc', '-t', 'code',
      '--session-dir', SESSIONS,
      ...(continueSession ? ['-c'] : []),
    ]
    const child = spawn('npx', args, { cwd: WORK, stdio: ['pipe', 'pipe', 'inherit'] })
    const timer = setTimeout(() => {
      console.error(`[${label}] timeout`)
      child.kill('SIGKILL')
      reject(new Error('phase timeout'))
    }, 280_000)
    let dialogSeen = null
    let lastText = ''
    // strict LF framing per docs (avoid readline's unicode splitting in JSON? content has no U+2028 normally; acceptable for a test)
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'extension_ui_request' && event.method === 'select') {
        dialogSeen = event.title
        console.log(`[${label}] dialog: ${event.title}`)
        console.log(`[${label}] answering: ${dialogAnswer}`)
        child.stdin.write(
          JSON.stringify({ type: 'extension_ui_response', id: event.id, value: dialogAnswer }) + '\n',
        )
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = (event.message.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
        if (text) lastText = text
      }
      if (event.type === 'agent_end') {
        clearTimeout(timer)
        child.stdin.end()
        child.kill('SIGKILL') // simulate abrupt shutdown; session file is already saved
        resolve({ dialogSeen, lastText })
      }
    })
    child.on('error', reject)
    child.stdin.write(JSON.stringify({ type: 'prompt', message: prompt }) + '\n')
  })
}

console.log('=== phase 1: trigger gated write, choose "Decide later", kill pi ===')
const phase1 = await runPhase({
  continueSession: false,
  label: 'phase1',
  dialogAnswer: LATER,
  prompt:
    'Use the code tool in a single snippet: compute total = sum of 1..100, print it, ' +
    'then call write("data/total.txt", str(total)). Report what happens.',
})
console.log(`[phase1] assistant: ${phase1.lastText.slice(0, 300)}`)
if (!phase1.dialogSeen?.includes('write(')) throw new Error('no write approval dialog appeared')
if (existsSync(`${WORK}/data/total.txt`)) throw new Error('file written despite suspension!')
console.log('[phase1] OK: suspended, pi killed, no file on disk\n')

console.log('=== phase 2: new pi process, resume, approve ===')
const phase2 = await runPhase({
  continueSession: true,
  label: 'phase2',
  dialogAnswer: 'Approve',
  prompt: 'I approve now — resume the suspended code script.',
})
console.log(`[phase2] assistant: ${phase2.lastText.slice(0, 300)}`)
const written = existsSync(`${WORK}/data/total.txt`)
  ? readFileSync(`${WORK}/data/total.txt`, 'utf8').trim()
  : null
console.log(`[phase2] data/total.txt = ${JSON.stringify(written)}`)
if (written !== '5050') throw new Error(`expected "5050", got ${JSON.stringify(written)}`)
console.log('\n✅ durable suspend/resume verified end-to-end across a process restart')
