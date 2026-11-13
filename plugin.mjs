import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Two ways to drive a SidePulse device, picked per event:
//
//   App mode    The SidePulse background service is running. Report each session's status
//               with `sidepulse report --json` and never touch LEDS.LED. The service
//               aggregates opencode with Codex/Claude/Grok and owns the display, so there
//               is no write conflict.
//   Direct mode No service. Write an LED program straight to LEDS.LED.
//
// Both paths are documented by the upstream project:
//   status reports  https://github.com/inteliwear/sidepulse/blob/main/docs/protocol/program-status.md
//   LED DSL         https://github.com/inteliwear/sidepulse/blob/main/LEDS_FORMAT.md

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

// Volume names differ by model (SidePulse, SidePulsePro, PulseDot), so match the prefix
// and confirm the control file exists. The Dot is FAT12, and its 11-character label limit
// rules out "SidePulseDot".
const VOLUME = /^(sidepulse|pulsedot)/i

// macOS mounts the device under /Volumes. The override lets the tests use a plain folder.
const VOLUMES = process.env.SIDEPULSE_VOLUMES || "/Volumes"

function mount() {
  try {
    for (const name of readdirSync(VOLUMES)) {
      const dir = join(VOLUMES, name)
      if (VOLUME.test(name) && existsSync(join(dir, "LEDS.LED"))) return dir
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

// The service keeps one status per session and renders the LEDs itself. Its documented
// input is the `sidepulse report` command, so nothing here depends on socket paths or the
// wire format. The command exits non-zero when no service answers, and that exit code is
// what selects direct mode.
//
// This replaces the app's events.sock. That socket still accepts a connection, but since
// upstream moved session state into the service it ignores everything except "open
// settings". The old transport therefore reported success while the device showed nothing.

// The upstream installer puts the CLI in ~/.local/bin. The opencode desktop app is started
// by launchd and often has no such entry on PATH, so look there before trusting PATH.
function command() {
  if (process.env.SIDEPULSE_BIN) return process.env.SIDEPULSE_BIN
  const installed = join(homedir(), ".local", "bin", "sidepulse")
  return existsSync(installed) ? installed : "sidepulse"
}

const ARGS = ["report", "--json"]
const STDIO = ["pipe", "ignore", "ignore"]
// The CLI gives the service half a second. The rest is Python startup.
const REPORT_TIMEOUT_MS = Number(process.env.SIDEPULSE_REPORT_TIMEOUT_MS) || 5000

// Resolves true only when the service accepted the report. A missing CLI, a stopped
// service and a hung process all resolve false, so the caller falls back to direct mode
// instead of throwing into a hook.
function run(body) {
  return new Promise((resolve) => {
    let child
    const timer = setTimeout(() => child?.kill(), REPORT_TIMEOUT_MS)
    timer.unref?.()
    const finish = (ok) => {
      clearTimeout(timer)
      resolve(ok)
    }
    try {
      // Detached and unref'd, so a report never holds the process open and is not taken
      // down with opencode's process group.
      child = spawn(command(), ARGS, { detached: true, stdio: STDIO, windowsHide: true })
      child.once("error", () => finish(false))
      child.once("exit", (code) => finish(code === 0))
      child.stdin.on("error", () => {})
      child.stdin.end(body)
      child.unref()
    } catch {
      finish(false)
    }
  })
}

// One report for the service. Only identity and state: no prompt, tool input or output.
function reportBody(sessionID, status, cwd) {
  return JSON.stringify({
    v: 1,
    type: "program_status",
    scope: `opencode-${sessionID}`,
    request_id: randomUUID(),
    status: { ...status, app: "opencode" },
    context: { provider: "opencode", session_id: sessionID, ...(cwd ? { cwd } : {}) },
  })
}

// True while the service accepts reports. It owns the LEDs and the keepalive then.
let appAlive = false

// The LED state the service last declined. Direct mode owns that state until it changes.
let declined

// Reports go out one at a time and in order. Each one is a separate process, so two in
// flight could land swapped, and the service never expires a Working status on its own:
// a "working" that overtakes its "done" would spin until the service restarts.
const pending = []
let inflight

async function pump() {
  if (inflight) return
  while ((inflight = pending.shift())) {
    try {
      const ok = await run(inflight.body)
      // The exit flush below may have taken this report over while it was in flight.
      if (inflight) settle(inflight, ok)
    } catch {}
    inflight = undefined
  }
}

function settle(job, ok) {
  appAlive = ok
  if (ok) {
    declined = undefined
    shown = undefined // the service owns the LEDs now; repaint if we take over later
    return
  }
  // Not delivered, so the next event for this session must be reported again.
  if (reported.get(job.sessionID) === job.key) reported.delete(job.sessionID)
  // A clear has no LED state. It only tidies the service.
  if (!job.state) return
  declined = job.state
  write(job.state)
}

// `opencode run` exits as soon as the turn ends, with the final report still queued or in
// flight. Send what is left synchronously. The report in flight goes first so the queue
// cannot overtake it. It is sent again even when nothing is queued behind it: its process
// is detached, but its body may not have left this process yet, and Bun drops a body that
// was written in the same tick as the exit. It keeps its request_id, and the service
// applies a repeated request_id only once, so a second copy changes nothing.
//
// A session still working or waiting at exit can never finish, and the service never
// expires those states on its own: the device would stay lit for a prompt nobody can
// answer. Clear those sessions. Done and error stay, because they are still news.
process.once("exit", () => {
  for (const [sessionID, key] of reported)
    if (key.startsWith("working") || key.startsWith("blocked"))
      pending.push({ sessionID, body: reportBody(sessionID, { state: "clear" }) })
  const jobs = [...(inflight ? [inflight] : []), ...pending.splice(0)]
  inflight = undefined
  for (const job of jobs) {
    // No service, so nothing to clear. Do not start a process per session to find out.
    if (!job.state && !appAlive) continue
    let ok = false
    try {
      const result = spawnSync(command(), ARGS, {
        input: job.body,
        stdio: STDIO,
        timeout: REPORT_TIMEOUT_MS,
        windowsHide: true,
      })
      ok = result.status === 0
    } catch {}
    settle(job, ok)
  }
})

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
  if (type === "session.idle") return "idle"
  // OpenCode v2 ends a turn with one of these three events, and sends no session.idle
  // or session.error.
  if (type === "session.execution.succeeded") return "idle"
  if (type === "session.execution.failed") return "error"
  if (type === "session.execution.interrupted") return "idle"
  if (type === "session.error")
    // A cancel is not a failure, so it must not go red. It gets no state of its own
    // beyond that: upstream sets IDLE_VISIBLE_SECONDS to 0, so an Idle / Ready status is
    // stale the instant it is set and can never be displayed. A cancel is also the one
    // state you already know about, because you just caused it. So it ends like any other
    // turn.
    return props.error?.name === "MessageAbortedError" ? "idle" : "error"
  if (type === "session.status") {
    const status = props.status?.type
    if (status === "retry" && !retrying) return "retry"
    if (status === "busy" && retrying) return "resume"
  }
  return null
}

// A permission prompt outranks a tool finishing, so a tool cannot stomp the amber
// prompt back to cyan.
// ponytail: one global flag, not per-session aggregation. In app mode the service does
// real per-session aggregation, so this only shapes direct mode.
let waiting = false

// True between a user message and the end of that turn. A cancelled turn can still settle
// its in-flight tool, so tool.execute.after may arrive after session.error. Without this
// guard that late event repaints cyan and the device spins forever on a dead turn.
// Upstream guards the same way: a terminal Stop is never resurrected.
let turnActive = false

// opencode retries a failed provider call and reports it through session.status. Retries
// are otherwise invisible, so a stalled turn looks exactly like a working one.
let retrying = false


// Each signal carries the LED state for direct mode and the program-status state for app
// mode. The service renders working, blocked, error and done as Working, Waiting for
// Input, Blocked / Error and Completed.
const SIGNALS = {
  start: { state: "busy", status: "working" },
  // Tool churn stays "working" in app mode. The service draws Tool Running exactly like
  // Working, and an unchanged status is not reported, so tools cost no process spawn.
  "tool-start": { state: "busy", status: "working" },
  "tool-end": { state: "hold", status: "working" },
  ask: { state: "waiting", status: "blocked" },
  reply: { state: "busy", status: "working" },
  idle: { state: "done", status: "done" },
  error: { state: "error", status: "error" },
  // A retry is a recoverable failure, which is upstream's own definition of
  // Blocked / Error. Reuse the error colour rather than add a sixth program: the point is
  // that the turn has stalled, and a stall that looks like work is the whole problem.
  retry: { state: "error", status: "error", msg: "Retrying a failed provider call" },
  resume: { state: "busy", status: "working" },
}

const TERMINAL = new Set(["idle", "error"])

function stateFor(signal) {
  const wanted = SIGNALS[signal].state
  if (signal === "ask") waiting = true
  if (signal === "start" || signal === "reply" || signal === "idle" || signal === "error")
    waiting = false
  if (signal === "start") turnActive = true
  if (TERMINAL.has(signal)) turnActive = false
  if (signal === "retry") retrying = true
  if (signal === "resume" || signal === "start" || TERMINAL.has(signal)) retrying = false
  // "hold" means a tool finished: stay amber if a prompt is still open.
  if (wanted === "hold") return waiting ? "waiting" : "busy"
  return wanted
}

// App mode status. The service keeps one status per session, so the open prompt is tracked
// per session here: the global flag above would let a prompt in one session mark another
// session as blocked. A prompt outranks tool churn in its own session and nothing else.
const prompts = new Map() // sessionID -> kind of the open prompt

function statusFor(signal, sessionID, tool) {
  if (signal === "ask") prompts.set(sessionID, BLOCKING_TOOLS.has(tool) ? "question" : "permission")
  else if (signal !== "tool-start" && signal !== "tool-end") prompts.delete(sessionID)
  const kind = prompts.get(sessionID)
  if (kind) return { state: "blocked", kind }
  const { status, msg } = SIGNALS[signal]
  return { state: status, ...(msg ? { msg } : {}) }
}

// Sessions whose turn ended in an error. OpenCode 1 follows session.error with
// session.idle, and that idle would paint a failed turn green. Measured on 1.19.5.
const failed = new Set()

// The last status handed to the queue for each session. An unchanged status is skipped.
// ponytail: never pruned. It holds one short string per session for the process lifetime.
const reported = new Map()

// Never throw into a hook, and never make one wait: the report is queued and the hook
// returns. A status light must not be able to break a turn or slow it down.
function report(signal, sessionID, cwd, tool) {
  try {
    if (signal === "error") failed.add(sessionID)
    else if (signal !== "idle") failed.delete(sessionID)
    else if (failed.has(sessionID)) return
    const state = stateFor(signal)
    const status = statusFor(signal, sessionID, tool)
    const key = `${status.state}:${status.kind ?? ""}`
    // The service has this status, or is about to.
    if (reported.get(sessionID) === key) return
    // Direct mode, and the service already declined this state. Paint, which is free when
    // nothing changed, and ask the service again on the next change instead of starting a
    // process for every tool call.
    if (!appAlive && state === declined) return void write(state)
    reported.set(sessionID, key)
    pending.push({ state, sessionID, key, body: reportBody(sessionID, status, cwd) })
    // Prefer the service. A report it does not accept falls back to direct mode in settle().
    pump()
  } catch {}
}

// The MacBook SD reader cuts power to the device after three minutes of inactivity.
// The service does its own keepalive, so only do it when the service is absent.
function beat() {
  if (appAlive) return
  const dir = mount()
  if (!dir) return
  try {
    const now = new Date()
    utimesSync(join(dir, "keepalive"), now, now)
  } catch {}
}

function keepalive() {
  const alive = setInterval(beat, 60_000)
  // Do not hold the process open on exit.
  alive.unref?.()
  return () => clearInterval(alive)
}

// A cancelled turn can still settle its in-flight tool, so drop tool events that arrive
// after the turn ended. A new turn re-arms the guard, so nothing is lost.
function onTool(phase, tool, sessionID, cwd) {
  return turnActive && report(signalForTool(tool, phase), sessionID, cwd, tool)
}

// v1 events carry their payload in `properties`, v2 events in `data`.
function onEvent(event, cwd) {
  const props = event.properties ?? event.data ?? {}
  const signal = signalForEvent(event.type, props)
  if (!signal) return
  return report(signal, props.sessionID ?? props.session_id ?? "unknown", cwd)
}

// One default export: OpenCode v1 calls server(), v2 calls setup(). Tested on 1.17.20.
// No named export, because v1 can load it as a second instance that fights for the device.
// NOTE: no paint on init, because opencode re-initializes plugins during a session.
const plugin = {
  id: "opencode-sidepulse",

  async server({ directory } = {}) {
    const cwd = directory ?? process.cwd()
    const stop = keepalive()
    return {
      dispose: async () => stop(),
      "chat.message": async (input) => report("start", input.sessionID, cwd),
      "tool.execute.before": async (input) => onTool("before", input.tool, input.sessionID, cwd),
      "tool.execute.after": async (input) => onTool("after", input.tool, input.sessionID, cwd),
      event: async ({ event }) => onEvent(event, cwd),
    }
  },

  async setup(ctx) {
    const cwd = ctx.location?.directory ?? process.cwd()
    const stop = keepalive()
    const controller = new AbortController()
    await ctx.session.hook("prompt", (e) => report("start", e.sessionID, cwd))
    await ctx.tool.hook("execute.before", (e) => onTool("before", e.tool, e.sessionID, cwd))
    await ctx.tool.hook("execute.after", (e) => onTool("after", e.tool, e.sessionID, cwd))
    // The stream ends on abort. Swallow that, and any other stream error, so the status
    // light can never break opencode.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }))
          await onEvent(event, cwd)
      } catch {}
    })()
    return () => {
      controller.abort()
      stop()
    }
  },
}

export default plugin

// Stryker disable all: everything below is test code, not plugin code.
// Self-check. Run it with: node plugin.mjs   (also works under bun)
//   --demo   walk every LED state on the device, four seconds each
//   --send   send one test report through the sidepulse CLI and print the result
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

  const signals = ["start", "tool-start", "ask", "tool-end", "reply", "idle", "error"]
  const want = ["busy", "busy", "waiting", "waiting", "busy", "done", "error"]
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
  ]
  for (const [signals_, want_] of flows) {
    const seen = signals_.map(stateFor)
    if (seen.join() !== want_.join())
      throw new Error(`flow ${signals_.join(">")}: got ${seen.join()}, want ${want_.join()}`)
  }
  stateFor("start")
  for (const terminal of ["idle", "error"]) {
    stateFor("start")
    stateFor(terminal)
    if (turnActive) throw new Error(`${terminal} left the turn armed`)
  }

  // In app mode the service owns the display, so the status we report matters more than
  // the local state. Checking the local state alone once missed a cancel finishing green.
  const WANT_STATUS = {
    start: "working",
    "tool-start": "working",
    "tool-end": "working",
    ask: "blocked",
    reply: "working",
    idle: "done",
    error: "error",
    retry: "error",
    resume: "working",
  }
  for (const [signal, wantStatus] of Object.entries(WANT_STATUS)) {
    const actual = statusFor(signal, "check-status").state
    if (actual !== wantStatus) throw new Error(`${signal} reports ${actual}, want ${wantStatus}`)
  }

  // A prompt holds its own session at blocked through tool churn, names its kind, and
  // leaves every other session alone.
  const sessions = [
    ["ask", "a", undefined, "blocked:permission"],
    ["tool-end", "a", "bash", "blocked:permission"],
    ["tool-start", "a", "bash", "blocked:permission"],
    ["tool-end", "b", "bash", "working:"],
    ["reply", "a", undefined, "working:"],
    ["ask", "a", "question", "blocked:question"],
    ["idle", "a", undefined, "done:"],
    ["tool-end", "a", "bash", "working:"],
  ]
  for (const [signal, id, tool, wantKey] of sessions) {
    const status = statusFor(signal, `check-${id}`, tool)
    const actual = `${status.state}:${status.kind ?? ""}`
    if (actual !== wantKey) throw new Error(`session ${id} ${signal}: reports ${actual}, want ${wantKey}`)
  }

  // Real traces, captured from the desktop app with a logging probe. Replaying them is
  // the only check that would have caught green appearing after a cancel.
  const traces = {
    // A cancel deliberately ends like a normal turn. Upstream filters Idle / Ready
    // instantly, so there is no state that could show "cancelled" instead.
    "ctrl+g cancel": [
      ["chat.message", null, "busy"],
      ["session.error", { error: { name: "MessageAbortedError" } }, "done"],
      ["session.idle", {}, "done"],
      ["session.idle", {}, "done"],
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
    // OpenCode 2.1.2 traces, captured with a logging probe plugin.
    "v2 normal finish": [
      ["chat.message", null, "busy"],
      ["session.execution.started", {}, "busy"],
      ["session.execution.succeeded", {}, "done"],
    ],
    "v2 cancel": [
      ["chat.message", null, "busy"],
      ["session.execution.started", {}, "busy"],
      ["session.execution.interrupted", { reason: "user" }, "done"],
    ],
    "v2 failure": [
      ["chat.message", null, "busy"],
      ["session.execution.started", {}, "busy"],
      ["session.execution.failed", { error: { type: "provider.no-route" } }, "error"],
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

  // v1 needs server(), and v2 needs id and setup().
  if (typeof plugin.id !== "string" || typeof plugin.server !== "function" || typeof plugin.setup !== "function")
    throw new Error("default export needs id, server() and setup()")

  for (const name of ["SidePulse", "SidePulsePro", "PulseDot"]) {
    if (!VOLUME.test(name)) throw new Error(`volume ${name} does not match ${VOLUME}`)
  }
  if (VOLUME.test("Macintosh HD")) throw new Error(`volume Macintosh HD matches ${VOLUME}`)

  console.log(`ok: ${Object.keys(PROGRAMS).length} programs, ${want.length} transitions`)
  console.log(`   device     ${mount() ?? "not mounted"}`)
  console.log(`   app CLI    ${command()}`)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Exercise the real run(), so a broken transport cannot hide behind the direct-mode
  // fallback. This is the check that would have caught the Bun.connect regression.
  if (process.argv.includes("--send")) {
    // run() unrefs its child so it can never hold opencode open. Nothing else is running
    // here, so hold the process open until the CLI answers.
    const hold = setInterval(() => {}, 1000)
    // "clear" removes a session, so this proves delivery and leaves nothing in the menu.
    const ok = await run(reportBody("selfcheck", { state: "clear" }))
    clearInterval(hold)
    console.log(
      ok
        ? "   --send: accepted by the SidePulse service"
        : "   --send: NOT accepted. Check `sidepulse service status`. Direct mode would be used.",
    )
    if (!ok) process.exitCode = 1
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
