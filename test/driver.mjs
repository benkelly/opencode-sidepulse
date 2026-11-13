// Runs one scenario against the plugin in a fresh process, so module state starts clean and
// the exit hook really runs. run.mjs starts one of these per test.
//
// Steps are JSON arrays:
//   ["prompt", session]              the user sent a message
//   ["before", session, tool]        tool.execute.before
//   ["after", session, tool]         tool.execute.after
//   ["event", type, payload]         a bus event
//   ["service", "up" | "down"]       start or stop the fake service
//   ["delay", seconds]               make the next CLI call slow
//   ["led"]                          record what LEDS.LED holds now
//   ["write-led", text]              overwrite LEDS.LED, as the service would
//   ["beat"]                         run one keepalive tick
//   ["status"]                       record what the real service shows (service.mjs only)
//   ["dispose"]                      unload the plugin
//   ["exit"]                         leave at once, like `opencode run`
//   ["fast", [steps]]                run steps without waiting for reports, during or after
//   ["drain"]                        wait for the report queue to empty
// Every step except "fast" waits until the report queue is empty before the next one starts.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const scenario = JSON.parse(process.env.SCENARIO)
const dir = process.env.SCENARIO_DIR
const fake = process.env.FAKE_SIDEPULSE_DIR
const led = process.env.SCENARIO_LED

// The plugin exports only its default object, on purpose. To see inside, load a copy with
// one extra export. Nothing in the published file changes for the tests.
const source = readFileSync(new URL("../plugin.mjs", import.meta.url), "utf8")
const copy = join(dir, "plugin.under-test.mjs")
writeFileSync(
  copy,
  `${source}\nexport const internals = { drained: () => !inflight && !pending.length, beat }\n`,
)
const { default: plugin, internals } = await import(pathToFileURL(copy).href)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function drain() {
  const deadline = Date.now() + 10_000
  while (!internals.drained()) {
    if (Date.now() > deadline) throw new Error("the report queue never emptied")
    await sleep(1)
  }
}

const results = { id: plugin.id, leds: [], keepalive: [], status: [] }
const save = () => writeFileSync(join(dir, "result.json"), JSON.stringify(results))

// ------------------------------------------------------------- fake OpenCode

const directory = "/projects/demo"
let hooks
let unload

// OpenCode 1 hands hooks back from server() and carries event payloads in `properties`.
async function v1() {
  const h = await plugin.server({ directory })
  hooks = {
    prompt: (sessionID) => h["chat.message"]({ sessionID }),
    before: (sessionID, tool) => h["tool.execute.before"]({ tool, sessionID }),
    after: (sessionID, tool) => h["tool.execute.after"]({ tool, sessionID }),
    event: (type, properties) => h.event({ event: { type, properties } }),
  }
  unload = () => h.dispose()
}

// OpenCode 2 registers hooks on a context, streams events, and carries payloads in `data`.
async function v2() {
  const registered = {}
  const queue = []
  let wake
  let ended = false
  const ctx = {
    location: { directory },
    session: { hook: async (name, fn) => void (registered[`session.${name}`] = fn) },
    tool: { hook: async (name, fn) => void (registered[`tool.${name}`] = fn) },
    event: {
      subscribe: ({ signal }) =>
        (async function* () {
          signal.addEventListener("abort", () => wake?.())
          while (!signal.aborted) {
            const next = queue.shift()
            if (!next) {
              await new Promise((resolve) => (wake = resolve))
              continue
            }
            yield next.event
            // The consumer asked for the next event, so it has finished with this one.
            next.handled()
          }
          // Unsubscribed. Later events reach nobody.
          ended = true
          for (const left of queue.splice(0)) left.handled()
        })(),
    },
  }
  const stop = await plugin.setup(ctx)
  hooks = {
    prompt: (sessionID) => registered["session.prompt"]({ sessionID }),
    before: (sessionID, tool) => registered["tool.execute.before"]({ tool, sessionID }),
    after: (sessionID, tool) => registered["tool.execute.after"]({ tool, sessionID }),
    event: (type, data) =>
      new Promise((handled) => {
        if (ended) return handled()
        queue.push({ event: { type, data }, handled })
        wake?.()
      }),
  }
  unload = () => stop()
}

// ------------------------------------------------------------------- steps

async function step([name, ...args], wait = true) {
  switch (name) {
    case "prompt":
    case "before":
    case "after":
    case "event":
      await hooks[name](...args)
      break
    case "service":
      if (args[0] === "up") writeFileSync(join(fake, "up"), "")
      else rmSync(join(fake, "up"), { force: true })
      break
    case "delay":
      writeFileSync(join(fake, "delay-once"), String(args[0]))
      break
    case "led":
      results.elapsedToFirstLed ??= Date.now() - started
      results.leds.push(existsSync(led) ? readFileSync(led, "utf8") : null)
      save()
      break
    case "write-led":
      writeFileSync(led, args[0])
      break
    case "beat": {
      internals.beat()
      const file = join(led, "..", "keepalive")
      results.keepalive.push(existsSync(file) ? Date.now() - statSync(file).mtimeMs < 60_000 : null)
      save()
      break
    }
    case "status": {
      const { stdout } = spawnSync(process.env.SIDEPULSE_BIN, ["status", "--json", "--all"], { encoding: "utf8" })
      const snapshot = JSON.parse(stdout.split("\n")[0])
      const rows = [...snapshot.statuses, ...snapshot.stale_statuses]
      results.status.push(
        Object.fromEntries(rows.map((row) => [row.session_id, row.message ? `${row.mode} (${row.message})` : row.mode])),
      )
      save()
      break
    }
    case "dispose":
      await unload()
      break
    case "exit":
      process.exit(0)
    case "fast":
      for (const inner of args[0]) await step(inner, false)
      return
    case "drain":
      break
    default:
      throw new Error(`unknown step ${name}`)
  }
  if (wait) await drain()
}

await (scenario.opencode === 2 ? v2() : v1())
const started = Date.now()
for (const next of scenario.steps) await step(next)
save()
await unload()
