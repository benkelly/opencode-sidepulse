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

// Tools that block on you instead of doing work. `question` is opencode's multiple-choice
// prompt: tool.execute.before fires, then it waits for your answer for as long as you
// take. Reported as work it shows the busy animation, and the device never signals that
// it is your turn. A permission prompt arrives as an event, but this one arrives as a
// tool, so it needs its own mapping.
const BLOCKING_TOOLS = new Set(["question"])

function signalForTool(tool, phase) {
  const blocking = BLOCKING_TOOLS.has(tool)
  if (phase === "before") return blocking ? "ask" : "tool-start"
  return blocking ? "reply" : "tool-end"
}

// Map a bus event to a signal, or null to ignore it. Kept separate from the hook so the
// captured cancel and retry traces can be replayed in the self-check.
function signalForEvent(type, props) {
  // permission.updated is the SDK v1 name and permission.asked is the v2 name. A live
  // trace shows permission.asked, so both are needed across versions.
  if (type === "permission.updated" || type === "permission.asked") return "ask"
  if (type === "permission.replied") return "reply"
  // A cancelled turn ends with session.idle. Suppress it, or green overwrites the abort.
  if (type === "session.idle") return aborted ? null : "idle"
  if (type === "session.error")
    return props.error?.name === "MessageAbortedError" ? "abort" : "error"
  if (type === "session.status") {
    const status = props.status?.type
    if (status === "retry" && !retrying) return "retry"
    if (status === "busy" && retrying) return "resume"
  }
  return null
}

// A permission prompt outranks a tool finishing, so a tool cannot stomp the amber
// prompt back to cyan.
// ponytail: one global flag, not per-session aggregation. In app mode the app does real
// per-session aggregation, so this only shapes direct mode.
let waiting = false

// True between a user message and the end of that turn. A cancelled turn can still settle
// its in-flight tool, so tool.execute.after may arrive after session.error. Without this
// guard that late event repaints cyan and the device spins forever on a dead turn.
// Upstream guards the same way: a terminal Stop is never resurrected.
let turnActive = false

// opencode retries a failed provider call and reports it through session.status. Retries
// are otherwise invisible, so a stalled turn looks exactly like a working one.
let retrying = false

// A cancelled turn emits session.error with MessageAbortedError and then session.idle,
// twice, about a millisecond later. Captured from a real ctrl+g cancel:
//
//   session.error  error=MessageAbortedError
//   session.idle
//   session.idle
//
// Untracked, the dim abort state is repainted green as though the turn had finished.
// The flag survives until the next turn, so the repeat is covered too.
let aborted = false

// Each signal carries the LED state for direct mode and the upstream event name for app
// mode. Both mappings are verified against the upstream collector.
const SIGNALS = {
  start: { state: "busy", event: "UserPromptSubmit" },
  "tool-start": { state: "busy", event: "PreToolUse" },
  "tool-end": { state: "hold", event: "PostToolUse" },
  ask: { state: "waiting", event: "PermissionRequest" },
  reply: { state: "busy", event: "UserPromptSubmit" },
  idle: { state: "done", event: "Stop" },
  // An abort is your decision, not a failure, so no red. It is also not a completion, so
  // no green. SessionStart is the only upstream event that renders Idle / Ready, which is
  // what a cancelled turn actually is: nothing running and nothing achieved. SessionEnd
  // and Stop both render Completed, which is why cancelling used to finish green.
  abort: { state: "idle", event: "SessionStart" },
  error: { state: "error", event: "PostToolUseFailure" },
  // A retry is a recoverable failure, which is upstream's own definition of
  // Blocked / Error. Reuse the error colour rather than add a sixth program: the point is
  // that the turn has stalled, and a stall that looks like work is the whole problem.
  retry: { state: "error", event: "PostToolUseFailure" },
  resume: { state: "busy", event: "PostToolUse" },
}

const TERMINAL = new Set(["idle", "abort", "error"])

function stateFor(signal) {
  const wanted = SIGNALS[signal].state
  if (signal === "ask") waiting = true
  if (signal === "start" || signal === "reply" || signal === "idle" || signal === "abort" || signal === "error")
    waiting = false
  if (signal === "start") turnActive = true
  if (TERMINAL.has(signal)) turnActive = false
  if (signal === "retry") retrying = true
  if (signal === "resume" || signal === "start" || TERMINAL.has(signal)) retrying = false
  if (signal === "abort") aborted = true
  if (signal === "start") aborted = false
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
    // A cancelled turn can still settle its in-flight tool, so drop tool events that
    // arrive after the turn ended. A new turn re-arms the guard through chat.message,
    // so nothing is lost.
    "tool.execute.before": async (input) =>
      turnActive && report(signalForTool(input.tool, "before"), input.sessionID, cwd, input.tool),
    "tool.execute.after": async (input) =>
      turnActive && report(signalForTool(input.tool, "after"), input.sessionID, cwd, input.tool),
    event: async ({ event }) => {
      const props = event.properties ?? {}
      const signal = signalForEvent(event.type, props)
      if (!signal) return
      return report(signal, props.sessionID ?? props.session_id ?? "unknown", cwd)
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

  // A blocking tool must read as your turn, not as work. Both halves matter: amber while
  // the prompt is open, and back to cyan once it is answered.
  const routing = [
    ["question", "before", "ask", "waiting"],
    ["question", "after", "reply", "busy"],
    ["bash", "before", "tool-start", "busy"],
    ["bash", "after", "tool-end", "busy"],
  ]
  for (const [tool, phase, signal, state] of routing) {
    const actual = signalForTool(tool, phase)
    if (actual !== signal) throw new Error(`${tool}.${phase}: got ${actual}, want ${signal}`)
    const rendered = stateFor(actual)
    if (rendered !== state) throw new Error(`${tool}.${phase}: renders ${rendered}, want ${state}`)
  }

  // A retry must read as a stall and must recover, and a terminal signal must disarm the
  // turn so a late tool event cannot repaint cyan over a finished or cancelled turn.
  const flows = [
    [["start", "retry", "resume", "idle"], ["busy", "error", "busy", "done"]],
    [["start", "abort"], ["busy", "idle"]],
  ]
  for (const [signals_, want_] of flows) {
    const seen = signals_.map(stateFor)
    if (seen.join() !== want_.join())
      throw new Error(`flow ${signals_.join(">")}: got ${seen.join()}, want ${want_.join()}`)
  }
  stateFor("start")
  for (const terminal of ["idle", "abort", "error"]) {
    stateFor("start")
    stateFor(terminal)
    if (turnActive) throw new Error(`${terminal} left the turn armed`)
  }

  // In app mode the app owns the display, so the event we send matters more than the
  // local state. These mode mappings were measured against a live menu-bar app by
  // sending each event and reading back latest.json. Checking the local state alone
  // missed a cancel finishing green, because SessionEnd renders as Completed.
  const APP_MODES = {
    SessionStart: "idle_ready",
    UserPromptSubmit: "working",
    PreToolUse: "tool_running",
    PostToolUse: "working",
    PermissionRequest: "waiting_for_input",
    PostToolUseFailure: "blocked_error",
    Stop: "completed",
    SessionEnd: "completed",
  }
  const WANT_APP_MODE = {
    start: "working",
    "tool-start": "tool_running",
    "tool-end": "working",
    ask: "waiting_for_input",
    reply: "working",
    idle: "completed",
    abort: "idle_ready",
    error: "blocked_error",
    retry: "blocked_error",
    resume: "working",
  }
  for (const [signal, wantMode] of Object.entries(WANT_APP_MODE)) {
    const event = SIGNALS[signal].event
    if (APP_MODES[event] !== wantMode)
      throw new Error(`${signal} sends ${event}, which the app renders as ${APP_MODES[event]}, want ${wantMode}`)
  }

  // Real traces, captured from the desktop app with a logging probe. Replaying them is
  // the only check that would have caught green appearing after a cancel.
  const traces = {
    "ctrl+g cancel": [
      ["chat.message", null, "busy"],
      ["session.error", { error: { name: "MessageAbortedError" } }, "idle"],
      ["session.idle", {}, "idle"],
      ["session.idle", {}, "idle"],
    ],
    "normal finish": [
      ["chat.message", null, "busy"],
      ["session.idle", {}, "done"],
    ],
    "provider retry": [
      ["chat.message", null, "busy"],
      ["session.status", { status: { type: "retry" } }, "error"],
      ["session.status", { status: { type: "busy" } }, "busy"],
      ["session.idle", {}, "done"],
    ],
  }
  for (const [name, steps] of Object.entries(traces)) {
    let state = null
    for (const [type, props, want] of steps) {
      const signal = type === "chat.message" ? "start" : signalForEvent(type, props)
      if (signal) state = stateFor(signal)
      if (state !== want) throw new Error(`${name}: after ${type} state is ${state}, want ${want}`)
    }
  }

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
