/**
 * Smoke test for @pydantic/monty — verifies the primitives our code tool depends on:
 * 1. async external functions (the tool bridge)
 * 2. print() capture (the observation channel)
 * 3. the raw pause/resume state machine (per-call interception)
 * 4. MontyRepl persistent state + dump/load (session persistence)
 * 5. runtime errors with Python tracebacks (model-facing error feedback)
 * 6. resource limits
 */
import {
  Monty,
  MontyRepl,
  MontySnapshot,
  MontyNameLookup,
  MontyComplete,
  MontyRuntimeError,
  runMontyAsync,
} from '@pydantic/monty'

// 1 + 2: async external functions and print capture
// NOTE: external functions are called WITHOUT `await` — the host-side pause/resume
// bridge makes them synchronous from Python's perspective (verified on 0.0.18;
// resuming with a plain value makes `await` fail with "'int' object can't be awaited").
const code1 = `
results = []
for city in cities:
    temp = get_temp(city)
    results.append(f"{city}: {temp}C")
print(", ".join(results))
max(int(r.split(": ")[1][:-1]) for r in results)
`
const m1 = new Monty(code1, { inputs: ['cities'] })
const stdout: string[] = []
const out1 = await runMontyAsync(m1, {
  inputs: { cities: ['Berlin', 'Tokyo'] },
  externalFunctions: {
    get_temp: async (city: unknown) => (city === 'Tokyo' ? 28 : 17),
  },
  // must return undefined — the native layer raises TypeError on any other return value
  printCallback: (_stream, text) => {
    stdout.push(text)
  },
})
console.log('1/2 external functions + print:', JSON.stringify({ out1, stdout }))

// 3: raw pause/resume — intercept each call ourselves
const m2 = new Monty('double(7) + double(3)')
let progress = m2.start()
const calls: string[] = []
while (!(progress instanceof MontyComplete)) {
  if (progress instanceof MontyNameLookup) {
    // resolve the unknown name to a marker so the call pauses as a snapshot
    progress = progress.resume({ value: () => {} })
  } else if (progress instanceof MontySnapshot) {
    calls.push(`${progress.functionName}(${JSON.stringify(progress.args)})`)
    progress = progress.resume({ returnValue: Number(progress.args[0]) * 2 })
  }
}
console.log('3   pause/resume:', JSON.stringify({ calls, output: progress.output }))

// 4: REPL persistence + serialization round-trip
const repl = new MontyRepl()
repl.feed('x = 41')
const restored = MontyRepl.load(repl.dump())
console.log('4   repl dump/load:', JSON.stringify(restored.feed('x + 1')))

// 5: runtime error with traceback
try {
  new Monty('def f():\n    return 1 / 0\nf()').run()
} catch (e) {
  if (e instanceof MontyRuntimeError) {
    console.log('5   traceback:\n' + e.display('traceback'))
  }
}

// 6: limits
try {
  new Monty('while True:\n    pass').run({ limits: { maxDurationSecs: 1 } })
} catch (e) {
  console.log('6   limit enforced:', (e as Error).constructor.name, (e as Error).message.slice(0, 80))
}
