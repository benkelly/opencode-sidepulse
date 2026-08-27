import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

// Two ways to drive a SidePulse device, picked per event:
//
//   App mode    The SidePulse menu-bar app is running. Send hook events to its Unix
//               socket and never touch LEDS.LED. The app aggregates opencode with
//               Codex/Claude/Grok and owns the display, so there is no write conflict.
//   Direct mode No app. Write an LED program straight to LEDS.LED.
//
// Both paths are documented by the upstream project:
//   socket protocol  https://github.com/inteliwear/sidepulse/blob/main/src/sidepulse/ipc.py
//   LED DSL          https://github.com/inteliwear/sidepulse/blob/main/LEDS_FORMAT.md

// ---------------------------------------------------------------- direct mode

// Controller limits: 512 bytes and 20 lines. A parse error blinks all LEDs red six times.
const PROGRAMS = {
  // Very dim breathing. Nothing is running.
  idle: "off\n#101018 2.5s pulse\nrepeat\n",
  // Cyan comet. The agent is thinking or running a tool.
  // ponytail: one program for both. Upstream maps Working and Tool Running to the same
  // cyan roll, and sharing it means tool churn writes nothing and never restarts the roll.
  busy: "off\n0:#00ccff 1:#0088cc 2:#004466 3:#001a26\nroll 1.2s linear\nrepeat\n",
  // Amber breathing. A permission prompt waits for you.
  waiting: "off\n#ffb000 1.4s pulse\nrepeat\n",
  // Red breathing. The turn failed.
  error: "off\n#ff2000 0.9s pulse\nrepeat\n",
  // Solid green, held until the next turn starts. A program without `repeat` holds its
  // final state, so no timer is needed to decay this.
  done: "#00ff22 0.6s cosine\n",
}

// Volume names differ by model (SidePulse, SidePulsePro, SidePulseDot), so match the
// prefix and confirm the control file exists.
function mount() {
  try {
    for (const name of readdirSync("/Volumes")) {
      const dir = join("/Volumes", name)
      if (/^sidepulse/i.test(name) && existsSync(join(dir, "LEDS.LED"))) return dir
    }
  } catch {}
  return undefined
}

let shown

function write(state) {
  if (state === shown) return true
  const dir = mount()
  if (!dir) {
    shown = undefined
    return false
  }
  try {
    writeFileSync(join(dir, "LEDS.LED"), PROGRAMS[state])
    shown = state
    return true
  } catch {
    shown = undefined
    return false
  }
}

// ------------------------------------------------------------------- app mode

// Upstream default_state_dir() honors XDG_STATE_HOME from its OWN environment. The app is
// launched by launchd and usually has none, while opencode may well have one set (the
// opencode desktop app sets it per-app). The two processes therefore disagree on the path,
// so probe every candidate instead of computing one.
const CANDIDATES = [
  ...new Set([
    ...(process.env.XDG_STATE_HOME ? [process.env.XDG_STATE_HOME] : []),
    join(homedir(), ".local", "state"),
  ]),
].map((base) => join(base, "sidepulse", "agent-monitor", "events.sock"))

function socket() {
  return CANDIDATES.find((path) => existsSync(path))
}

// The app reads one JSON object per connection and stops at EOF, so the client must
// half-close after writing. end(payload) writes and then sends FIN, which is that EOF.
// Upstream caps a message at 1 MiB; ours are tiny.
//
// Use node:net, not Bun.connect. Bun globals are not reachable from an npm-installed
// plugin, so Bun.connect threw ReferenceError, the catch below swallowed it, and app mode
// silently degraded to direct mode. node:net is stdlib and works under any runtime.
//
// Any failure resolves false so the caller falls back to direct mode instead of throwing
// into a hook.
function send(path, event, sessionID, cwd, tool) {
  const payload = JSON.stringify({
    provider: "opencode",
    line: {
      hook_event_name: event,
      session_id: sessionID,
      cwd,
      // Upstream origin_label_from_payload() reads this key, so the app labels the agent
      // instead of leaving origin empty. Providers it does not know get no origin at all.
      agent_origin: "opencode",
      ...(tool ? { tool_name: tool } : {}),
    },
  })
  return new Promise((resolve) => {
    let socket
    // Never let a hung socket stall a turn. Upstream uses a 200 ms timeout; match it.
    const timer = setTimeout(() => {
      socket?.destroy()
      resolve(false)
    }, 200)
    const finish = (ok) => {
      clearTimeout(timer)
      resolve(ok)
    }
    try {
      socket = createConnection({ path }, () => socket.end(payload, () => finish(true)))
      socket.on("error", () => finish(false))
    } catch {
      finish(false)
    }
  })
}

// ------------------------------------------------------------------- dispatch

// A permission prompt outranks a tool finishing, so a tool cannot stomp the amber
// prompt back to cyan.
// ponytail: one global flag, not per-session aggregation. In app mode the app does real
// per-session aggregation, so this only shapes direct mode.
let waiting = false

// Each signal carries the LED state for direct mode and the upstream event name for app
// mode. Both mappings are verified against the upstream collector.
const SIGNALS = {
  start: { state: "busy", event: "UserPromptSubmit" },
  "tool-start": { state: "busy", event: "PreToolUse" },
  "tool-end": { state: "hold", event: "PostToolUse" },
  ask: { state: "waiting", event: "PermissionRequest" },
  reply: { state: "busy", event: "UserPromptSubmit" },
  idle: { state: "done", event: "Stop" },
  // An abort is your decision, not a failure. Do not show red for it.
  abort: { state: "idle", event: "SessionEnd" },
  error: { state: "error", event: "PostToolUseFailure" },
}

function stateFor(signal) {
  const wanted = SIGNALS[signal].state
  if (signal === "ask") waiting = true
  if (signal === "start" || signal === "reply" || signal === "idle" || signal === "abort" || signal === "error")
    waiting = false
  // "hold" means a tool finished: stay amber if a prompt is still open.
  if (wanted === "hold") return waiting ? "waiting" : "busy"
  return wanted
}

// Never throw into a hook. A status light must not be able to break a turn.
async function report(signal, sessionID, cwd, tool) {
  try {
    const state = stateFor(signal)
    // Prefer the app. Only fall through when no socket answers, which also covers a
    // stale socket file left behind by a crash.
    const path = socket()
    if (path && (await send(path, SIGNALS[signal].event, sessionID, cwd, tool))) {
      shown = undefined // the app owns the LEDs now; repaint if we take over later
      return
    }
    write(state)
  } catch {}
}

// ponytail: paint nothing on init. opencode disposes and re-initializes plugins during a
// session, so an init paint would stomp the live state back to idle. The device holds its
// last program anyway, and shows INIT.LED on power-up.
export const SidePulse = async ({ directory } = {}) => {
  const cwd = directory ?? process.cwd()

  // The MacBook SD reader cuts power to the device after three minutes of inactivity.
  // The app does its own keepalive, so only do it when the app is absent.
  const alive = setInterval(() => {
    if (socket()) return
    const dir = mount()
    if (!dir) return
    try {
      const now = new Date()
      utimesSync(join(dir, "keepalive"), now, now)
    } catch {}
  }, 60_000)
  // Do not hold the process open on exit.
  alive.unref?.()

  return {
    dispose: async () => {
      clearInterval(alive)
    },
    "chat.message": async (input) => report("start", input.sessionID, cwd),
    "tool.execute.before": async (input) => report("tool-start", input.sessionID, cwd, input.tool),
    "tool.execute.after": async (input) => report("tool-end", input.sessionID, cwd, input.tool),
    event: async ({ event }) => {
      // permission.updated is the SDK v1 name and permission.asked is the v2 name.
      // Handle both, so a version bump does not silently stop the amber prompt.
      const type = event.type
      const props = event.properties ?? {}
      const session = props.sessionID ?? props.session_id ?? "unknown"
      if (type === "permission.updated" || type === "permission.asked") return report("ask", session, cwd)
      if (type === "permission.replied") return report("reply", session, cwd)
      if (type === "session.idle") return report("idle", session, cwd)
      if (type === "session.error") {
        const aborted = props.error?.name === "MessageAbortedError"
        return report(aborted ? "abort" : "error", session, cwd)
      }
    },
  }
}

export default SidePulse

// Self-check. Run it with: node plugin.mjs   (also works under bun)
//   --demo   walk every LED state on the device, four seconds each
//   --send   send one test event to a live app socket and report the result
// opencode imports this file, so this block stays out of the plugin path. import.meta.main
// is a bun-ism, so check argv too, which keeps the check runnable under plain node.
const selfCheck =
  import.meta.main || process.argv[1]?.endsWith("plugin.mjs")
if (selfCheck) {
  for (const [name, program] of Object.entries(PROGRAMS)) {
    const bytes = Buffer.byteLength(program)
    const lines = program.trimEnd().split("\n").length
    if (bytes > 512 || lines > 20) throw new Error(`${name} exceeds the controller: ${bytes} bytes, ${lines} lines`)
  }

  const signals = ["start", "tool-start", "ask", "tool-end", "reply", "idle", "error", "abort"]
  const want = ["busy", "busy", "waiting", "waiting", "busy", "done", "error", "idle"]
  const got = signals.map(stateFor)
  if (got.join() !== want.join()) throw new Error(`state machine: got ${got.join()}, want ${want.join()}`)

  console.log(`ok: ${Object.keys(PROGRAMS).length} programs, ${want.length} transitions`)
  console.log(`   device     ${mount() ?? "not mounted"}`)
  console.log(`   app socket ${socket() ?? "absent, using direct mode"}`)
  for (const path of CANDIDATES) console.log(`   probed     ${path}`)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Exercise the real send(), so a broken transport cannot hide behind the direct-mode
  // fallback. This is the check that would have caught the Bun.connect regression.
  if (process.argv.includes("--send")) {
    const path = socket()
    if (!path) {
      console.log("   --send: no app socket, nothing to test")
    } else {
      const ok = await send(path, "Stop", "selfcheck-session", process.cwd())
      console.log(`   --send: ${ok ? "delivered to" : "FAILED against"} ${path}`)
      if (!ok) process.exitCode = 1
    }
  }

  if (process.argv.includes("--demo")) {
    for (const state of Object.keys(PROGRAMS)) {
      shown = undefined
      const ok = write(state)
      console.log(`   ${state}${ok ? "" : "  <-- write failed"}`)
      await sleep(4000)
    }
  }
}
