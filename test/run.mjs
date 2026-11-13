// Regression tests for the plugin. Run with: node test/run.mjs   (or bun test/run.mjs)
// Pass a word to run only the tests whose name contains it. Add --keep to keep the folders
// of failed tests for a look.
//
// Each test drives the real plugin through fake OpenCode hooks in its own process (see
// driver.mjs), with a fake `sidepulse` CLI and a folder standing in for the device. It then
// compares what the service was told and what was written to LEDS.LED.
//
// No dependencies, like the plugin. It needs a POSIX shell for the fake CLI.

import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

const here = fileURLToPath(new URL(".", import.meta.url))
const FAKE_CLI = join(here, "fake-sidepulse")
const DRIVER = join(here, "driver.mjs")

// The LED programs, copied here on purpose. A change to what the device shows must be made
// twice, once in the plugin and once here.
const LED = {
  busy: "off\n0:#00ccff 1:#0088cc 2:#004466 3:#001a26\nroll 1.2s linear\nrepeat\n",
  waiting: "off\n#ffb000 1.4s pulse\nrepeat\n",
  error: "off\n#ff2000 0.9s pulse\nrepeat\n",
  done: "#00ff22 0.6s cosine\n",
  untouched: "untouched\n",
}

// Shorthand for steps.
const A = "ses_A"
const B = "ses_B"
const C = "ses_C"
const ev = (type, payload = {}) => ["event", type, payload]
const asked = (sessionID) => ev("permission.asked", { sessionID })
const replied = (sessionID) => ev("permission.replied", { sessionID })
const idle = (sessionID) => ev("session.idle", { sessionID })
const failed = (sessionID) => ev("session.error", { sessionID, error: { name: "ProviderError" } })
const status = (sessionID, type) => ev("session.status", { sessionID, status: { type } })
const times = (n, steps) => Array.from({ length: n }, () => steps).flat()

// Options:
//   opencode   1 (default) or 2: which plugin entry point the fake OpenCode calls
//   service    "up" (default), "down", or "none" for no CLI installed at all
//   steps      see driver.mjs
//   reports    what the service accepted, in order. Everything must have arrived by the
//              time the process ends.
//   declined   how many reports the CLI was given while the service was down
// A report that is sent twice keeps its request_id, and the real service applies it once.
// Both lists count it once too.
//   leds       what each ["led"] step saw
//   led        what LEDS.LED holds at the end. Defaults to "untouched" when the service is up.
//   keepalive  what each ["beat"] step saw: true when the file was touched
//   volume     name of the device folder (default "SidePulse"), or null for no device
//   ledFile    false: the device folder has no LEDS.LED
//   cli        where the CLI is found: "env" (default), "home", "path"
//   decoy      put a wrong CLI at "home" or "path". It must never run.
//   hang       the CLI never answers
//   env        extra environment for the plugin
//   check      a function given { bodies, result } for anything else
const tests = []
const test = (name, options) => tests.push({ name, ...options })

// ---------------------------------------------------------------- app mode

test("a turn reports working, blocked, working, done", {
  steps: [["prompt", A], ["before", A, "bash"], asked(A), replied(A), ["after", A, "bash"], idle(A)],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A working", "ses_A done"],
})

test("tool calls start no process", {
  steps: [["prompt", A], ...times(10, [["before", A, "bash"], ["after", A, "read"]]), idle(A)],
  reports: ["ses_A working", "ses_A done"],
})

test("the question tool reports a question, then work", {
  steps: [["prompt", A], ["before", A, "question"], ["after", A, "question"], idle(A)],
  reports: ["ses_A working", "ses_A blocked/question", "ses_A working", "ses_A done"],
})

test("a prompt holds its own session through tool calls, and no other", {
  steps: [
    ["prompt", A],
    asked(A),
    ["after", A, "bash"],
    ["before", A, "bash"],
    ["prompt", B],
    ["after", B, "bash"],
    ["before", B, "bash"],
    replied(A),
    idle(A),
    idle(B),
  ],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_B working", "ses_A working", "ses_A done", "ses_B done"],
})

test("a provider retry reports an error with a reason, then recovers", {
  steps: [
    ["prompt", A],
    ev("session.status", { sessionID: A, status: { type: "busy" } }),
    ev("session.status", { sessionID: A, status: { type: "retry" } }),
    ev("session.status", { sessionID: A, status: { type: "retry" } }),
    ev("session.status", { sessionID: A, status: { type: "busy" } }),
    ev("session.status", { sessionID: A, status: { type: "busy" } }),
    idle(A),
  ],
  reports: ["ses_A working", "ses_A error (Retrying a failed provider call)", "ses_A working", "ses_A done"],
})

test("a busy status resumes only after a retry", {
  steps: [
    ["prompt", A],
    asked(A),
    status(A, "busy"),
    replied(A),
    status(A, "retry"),
    status(A, "busy"),
    // The retry is over. A later busy status must not answer a prompt.
    asked(A),
    status(A, "busy"),
    replied(A),
    // A new turn ends a retry too.
    status(A, "retry"),
    ["prompt", A],
    asked(A),
    status(A, "busy"),
    // And so does the end of the turn.
    status(A, "retry"),
    idle(A),
    asked(A),
    status(A, "busy"),
    idle(A),
  ],
  reports: [
    "ses_A working",
    "ses_A blocked/permission",
    "ses_A working",
    "ses_A error (Retrying a failed provider call)",
    "ses_A working",
    "ses_A blocked/permission",
    "ses_A working",
    "ses_A error (Retrying a failed provider call)",
    "ses_A working",
    "ses_A blocked/permission",
    "ses_A error (Retrying a failed provider call)",
    "ses_A done",
    "ses_A blocked/permission",
    "ses_A done",
  ],
})

test("a retry that ends the turn does not report work first", {
  steps: [["prompt", A], status(A, "retry"), status(A, "idle"), idle(A)],
  reports: ["ses_A working", "ses_A error (Retrying a failed provider call)", "ses_A done"],
})

test("a question after a permission prompt changes the kind", {
  steps: [["prompt", A], asked(A), ["before", A, "question"], ["after", A, "question"], idle(A)],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A blocked/question", "ses_A working", "ses_A done"],
})

test("events before the first prompt report nothing", {
  steps: [["before", A, "bash"], ["after", A, "bash"], status(A, "busy"), ev("session.status", { sessionID: A })],
  reports: [],
})

test("a turn that ends while a prompt is open reports done", {
  steps: [["prompt", A], ev("permission.updated", { sessionID: A }), idle(A)],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A done"],
})

test("a tool call after the turn ended reports nothing", {
  steps: [["prompt", A], idle(A), ["after", A, "bash"], ["before", A, "bash"], ["before", A, "question"]],
  reports: ["ses_A working", "ses_A done"],
})

test("an event without a session id reports under unknown", {
  steps: [ev("permission.asked", {}), ev("session.idle", {})],
  reports: ["unknown blocked/permission", "unknown done"],
})

test("an event the plugin does not know reports nothing", {
  steps: [
    ["prompt", A],
    ev("message.updated", { sessionID: A, status: { type: "retry" } }),
    ev("session.created", { sessionID: A }),
    idle(A),
  ],
  reports: ["ses_A working", "ses_A done"],
})

test("a report carries identity and state, and nothing else", {
  steps: [["prompt", A], asked(A)],
  check({ bodies }) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const ids = bodies.map((body) => body.request_id)
    for (const id of ids) if (!uuid.test(id)) return `request_id ${id} is not a UUID`
    if (new Set(ids).size !== ids.length) return "request_ids repeat"
    const want = [
      {
        v: 1,
        type: "program_status",
        scope: "opencode-ses_A",
        status: { state: "working", app: "opencode" },
        context: { provider: "opencode", session_id: "ses_A", cwd: "/projects/demo" },
      },
      {
        v: 1,
        type: "program_status",
        scope: "opencode-ses_A",
        status: { state: "blocked", kind: "permission", app: "opencode" },
        context: { provider: "opencode", session_id: "ses_A", cwd: "/projects/demo" },
      },
      // The session is still blocked when the driver unloads, so the exit hook clears it.
      {
        v: 1,
        type: "program_status",
        scope: "opencode-ses_A",
        status: { state: "clear", app: "opencode" },
        context: { provider: "opencode", session_id: "ses_A" },
      },
    ]
    const got = bodies.map(({ request_id, ...rest }) => rest)
    if (!isDeepStrictEqual(got, want)) return `bodies differ:\n${JSON.stringify(got, null, 2)}`
  },
})

// ----------------------------------------------------------- recorded traces
//
// Event sequences recorded from real OpenCode releases with a logging probe. Events the
// plugin ignores are thinned out, but at least one of each kind stays in.
// test/opencode.mjs runs the same turns live.

test("OpenCode 1: cancel with ctrl+g ends like a finished turn", {
  steps: [
    ["prompt", A],
    ev("session.error", { sessionID: A, error: { name: "MessageAbortedError" } }),
    idle(A),
    idle(A),
  ],
  reports: ["ses_A working", "ses_A done"],
})

test("OpenCode 1.19.5: a turn that runs a tool", {
  steps: [
    ev("session.created", { sessionID: A }),
    ["prompt", A],
    ev("message.updated", { sessionID: A }),
    status(A, "busy"),
    ev("plugin.added", {}),
    ev("catalog.updated", {}),
    status(A, "busy"),
    ["before", A, "bash"],
    ["after", A, "bash"],
    status(A, "busy"),
    status(A, "idle"),
    idle(A),
    ev("catalog.updated", {}),
  ],
  reports: ["ses_A working", "ses_A done"],
})

// OpenCode 1 sends session.idle after session.error. The turn failed, so it must not end
// green.
const failedTurnOnOpenCode1 = [
  ev("session.created", { sessionID: A }),
  ["prompt", A],
  status(A, "busy"),
  ev("session.error", { sessionID: A, error: { name: "UnknownError", data: { message: "Model not found" } } }),
  status(A, "idle"),
  idle(A),
]

test("OpenCode 1.19.5: a failed turn stays an error", {
  steps: failedTurnOnOpenCode1,
  reports: ["ses_A working", "ses_A error"],
})

test("OpenCode 1.19.5: a failed turn stays red on the device", {
  service: "none",
  steps: [...failedTurnOnOpenCode1, ["led"], idle(B), ["led"], ["prompt", A], idle(A)],
  // Another session finishing still shows, and the next turn in the failed session starts clean.
  leds: ["error", "done"],
  led: "done",
})

test("OpenCode 1: an error without a name is still an error", {
  steps: [["prompt", A], ev("session.error", { sessionID: A })],
  reports: ["ses_A working", "ses_A error"],
})

test("OpenCode 1: a session works again after a failed turn", {
  steps: [...failedTurnOnOpenCode1, ["prompt", A], idle(A), failed(A), ["after", A, "bash"], idle(A)],
  reports: ["ses_A working", "ses_A error", "ses_A working", "ses_A done", "ses_A error"],
})

test("OpenCode 2: a turn reports working, blocked, working, done", {
  opencode: 2,
  steps: [
    ["prompt", A],
    ev("session.execution.started", { sessionID: A }),
    ["before", A, "bash"],
    asked(A),
    replied(A),
    ["after", A, "bash"],
    ev("session.execution.succeeded", { sessionID: A }),
  ],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A working", "ses_A done"],
})

test("OpenCode 2.1.2: a cancelled turn ends like a finished turn", {
  opencode: 2,
  steps: [
    ["prompt", A],
    ev("session.execution.started", { sessionID: A }),
    ev("session.execution.interrupted", { sessionID: A, reason: "user" }),
  ],
  reports: ["ses_A working", "ses_A done"],
})

test("OpenCode 2.3.0: a turn that runs a tool", {
  opencode: 2,
  steps: [
    ["prompt", A],
    ev("provider.updated", {}),
    ev("session.inbox.enqueued", { sessionID: A }),
    ev("session.execution.started", { sessionID: A }),
    ev("session.renamed", { sessionID: A }),
    ev("session.step.started", { sessionID: A }),
    ev("session.tool.called", { sessionID: A }),
    ["before", A, "shell"],
    ev("shell.created", {}),
    ev("session.tool.progress", { sessionID: A }),
    ev("shell.exited", {}),
    ["after", A, "shell"],
    ev("session.tool.success", { sessionID: A }),
    ev("session.step.ended", { sessionID: A }),
    ev("session.text.delta", { sessionID: A }),
    ev("session.execution.succeeded", { sessionID: A }),
    ev("location.shutdown", {}),
  ],
  reports: ["ses_A working", "ses_A done"],
})

test("OpenCode 2.3.0: a failed turn reports an error", {
  opencode: 2,
  steps: [
    ["prompt", A],
    ev("session.inbox.enqueued", { sessionID: A }),
    ev("session.execution.started", { sessionID: A }),
    ev("session.execution.failed", { sessionID: A, error: { type: "provider.no-route", message: "Model unavailable" } }),
    ev("location.shutdown", {}),
  ],
  reports: ["ses_A working", "ses_A error"],
})

test("OpenCode 2: the question tool and a snake_case session id", {
  opencode: 2,
  steps: [["prompt", A], ["before", A, "question"], ["after", A, "question"], ev("permission.asked", { session_id: B })],
  reports: ["ses_A working", "ses_A blocked/question", "ses_A working", "ses_B blocked/permission", "ses_A clear", "ses_B clear"],
})

test("OpenCode 2: unloading the plugin stops the event stream", {
  opencode: 2,
  steps: [["prompt", A], ev("session.execution.succeeded", { sessionID: A }), ["dispose"], asked(A)],
  reports: ["ses_A working", "ses_A done"],
})

test("OpenCode 2: reports carry the project directory", {
  opencode: 2,
  steps: [["prompt", A], ev("session.execution.succeeded", { sessionID: A })],
  check({ bodies, result }) {
    if (bodies[0]?.context.cwd !== "/projects/demo") return `cwd is ${bodies[0]?.context.cwd}`
    if (result.id !== "opencode-sidepulse") return `the plugin id is ${result.id}`
  },
})

// ------------------------------------------------------------ finding the CLI

test("the CLI is found in ~/.local/bin when SIDEPULSE_BIN is not set", {
  cli: "home",
  decoy: "path",
  steps: [["prompt", A], idle(A)],
  reports: ["ses_A working", "ses_A done"],
})

test("the CLI is found on PATH when it is nowhere else", {
  cli: "path",
  steps: [["prompt", A], idle(A)],
  reports: ["ses_A working", "ses_A done"],
})

test("SIDEPULSE_BIN wins over ~/.local/bin", {
  cli: "env",
  decoy: "home",
  steps: [["prompt", A], idle(A)],
  reports: ["ses_A working", "ses_A done"],
})

// -------------------------------------------------------------- direct mode

const turnOnTheDevice = [
  ["prompt", A],
  ["led"],
  asked(A),
  ["led"],
  ["after", A, "bash"],
  ["led"],
  ["before", A, "bash"],
  ["led"],
  replied(A),
  ["led"],
  failed(A),
  ["led"],
  ["prompt", A],
  ["led"],
  idle(A),
  ["led"],
]
const turnOnTheDeviceLeds = ["busy", "waiting", "waiting", "busy", "busy", "error", "busy", "done"]

test("no CLI: every state is written to the device", {
  service: "none",
  steps: turnOnTheDevice,
  leds: turnOnTheDeviceLeds,
  reports: [],
  led: "done",
})

test("service down: every state is written to the device", {
  service: "down",
  steps: turnOnTheDevice,
  leds: turnOnTheDeviceLeds,
  reports: [],
  led: "done",
})

test("service down: tool calls start no process", {
  service: "down",
  steps: [["prompt", A], ...times(10, [["before", A, "bash"], ["after", A, "read"]]), ["led"], idle(A)],
  leds: ["busy"],
  declined: 2,
  led: "done",
})

test("service down: a second session in the same state starts no process", {
  service: "down",
  steps: [["prompt", A], ["prompt", B], ["prompt", C]],
  declined: 1,
  led: "busy",
})

test("direct mode: a retry shows as an error, then recovers", {
  service: "none",
  steps: [
    ["prompt", A],
    ev("session.status", { sessionID: A, status: { type: "retry" } }),
    ["led"],
    ev("session.status", { sessionID: A, status: { type: "busy" } }),
    ["led"],
  ],
  leds: ["error", "busy"],
  led: "busy",
})

test("direct mode: the question tool shows as waiting, then busy", {
  service: "none",
  steps: [["prompt", A], ["before", A, "question"], ["led"], ["after", A, "question"], ["led"]],
  leds: ["waiting", "busy"],
  led: "busy",
})

test("direct mode: a prompt outranks a tool finishing in any session", {
  service: "none",
  steps: [["prompt", A], asked(A), ["after", B, "bash"], ["led"], ["prompt", B], ["led"]],
  leds: ["waiting", "busy"],
  led: "busy",
})

test("direct mode: a new turn forgets the last prompt", {
  service: "none",
  steps: [["prompt", A], asked(A), ["prompt", A], ["after", A, "bash"], ["led"]],
  leds: ["busy"],
  led: "busy",
})

test("direct mode: a tool call outside a turn does not repaint", {
  service: "none",
  steps: [asked(A), ["before", A, "bash"], ["led"]],
  leds: ["waiting"],
  led: "waiting",
})

test("direct mode: a tool call after the turn ended does not repaint", {
  service: "none",
  steps: [["prompt", A], idle(A), ["after", A, "bash"], ["before", A, "bash"]],
  led: "done",
})

test("direct mode: an unchanged state is not written again", {
  service: "none",
  steps: [["prompt", A], ["write-led", "someone else\n"], ["before", A, "bash"], ["after", A, "bash"]],
  led: "someone else\n",
})

test("direct mode: no device is not an error", {
  service: "none",
  volume: null,
  steps: [["prompt", A], asked(A), idle(A), ["led"], ["beat"]],
  leds: [null],
  keepalive: [null],
  led: null,
})

test("direct mode: a device that appears later is painted on the next event", {
  service: "none",
  ledFile: false,
  steps: [["prompt", A], ["led"], ["write-led", "fresh\n"], ["before", A, "bash"], ["led"]],
  leds: [null, "busy"],
  led: "busy",
})

for (const volume of ["SidePulsePro", "PulseDot", "sidepulse lower"])
  test(`direct mode: the volume ${volume} is a device`, {
    service: "none",
    volume,
    steps: [["prompt", A]],
    led: "busy",
  })

for (const volume of ["Macintosh HD", "My SidePulse"])
  test(`direct mode: the volume ${volume} is not a device`, {
    service: "none",
    volume,
    steps: [["prompt", A]],
    led: "untouched",
  })

// ------------------------------------------------- moving between the modes

test("the service takes the device over, and gives it back", {
  service: "down",
  steps: [
    ["prompt", A],
    ["led"],
    ["service", "up"],
    asked(A),
    ["write-led", "service owned\n"],
    ["before", A, "bash"],
    ["led"],
    ["service", "down"],
    replied(A),
    ["led"],
    idle(A),
  ],
  // The last "busy" matters: direct mode showed busy before the service took over, and it
  // must paint busy again afterwards instead of assuming the device still shows it.
  leds: ["busy", "service owned\n", "busy"],
  reports: ["ses_A blocked/permission"],
  led: "done",
})

test("a report the service declines is sent again when the state returns", {
  service: "down",
  steps: [["prompt", A], asked(A), ["service", "up"], replied(A), idle(A)],
  reports: ["ses_A working", "ses_A done"],
  declined: 2,
})

test("a CLI that never answers falls back to the device", {
  hang: true,
  env: { SIDEPULSE_REPORT_TIMEOUT_MS: "150" },
  steps: [["prompt", A], ["led"]],
  leds: ["busy"],
  reports: [],
  led: "busy",
})

// ------------------------------------------------------------- keepalive

test("keepalive: direct mode touches the file", {
  service: "none",
  steps: [["beat"]],
  keepalive: [true],
  led: "untouched",
})

test("keepalive: the service owns it in app mode", {
  steps: [["prompt", A], idle(A), ["beat"]],
  keepalive: [false],
})

// ------------------------------------------------------------------ order

test("a slow report is not overtaken by the ones behind it", {
  steps: [["delay", 0.3], ["fast", [["prompt", A], asked(A), idle(A)]], ["drain"]],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A done"],
})

test("hooks do not wait for the CLI", {
  steps: [["delay", 0.8], ["fast", [["prompt", A], ["led"]]], idle(A)],
  check({ result }) {
    if (result.elapsedToFirstLed > 500) return `the hook took ${result.elapsedToFirstLed} ms to return`
  },
  reports: ["ses_A working", "ses_A done"],
})

// ------------------------------------------------------------------- exit

test("exit: queued reports are sent, in order, before the process ends", {
  steps: [["delay", 0.3], ["fast", [["prompt", A], asked(A), idle(A)]], ["exit"]],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A done"],
})

test("exit: a session still working is cleared", {
  steps: [["prompt", A], ["exit"]],
  reports: ["ses_A working", "ses_A clear"],
})

test("exit: a session still waiting is cleared", {
  steps: [["prompt", A], asked(A), ["exit"]],
  reports: ["ses_A working", "ses_A blocked/permission", "ses_A clear"],
})

test("exit: done and error stay, working is cleared", {
  steps: [["prompt", A], idle(A), ["prompt", B], failed(B), ["prompt", C], ["exit"]],
  reports: ["ses_A working", "ses_A done", "ses_B working", "ses_B error", "ses_C working", "ses_C clear"],
})

test("exit: a report still in flight is sent again, then cleared", {
  steps: [["delay", 0.3], ["fast", [["prompt", A]]], ["exit"]],
  reports: ["ses_A working", "ses_A clear"],
})

test("exit: a finished turn still in flight arrives before the process ends", {
  steps: [["prompt", A], ["delay", 0.3], ["fast", [idle(A)]], ["exit"]],
  reports: ["ses_A working", "ses_A done"],
})

test("exit: direct mode starts no process to clear sessions", {
  service: "down",
  steps: [["prompt", A], ["prompt", B], asked(B), ["exit"]],
  reports: [],
  declined: 2,
  led: "waiting",
})

test("exit: queued reports fall back to the device when the service is down", {
  service: "down",
  steps: [["delay", 0.3], ["fast", [["prompt", A], idle(A)]], ["exit"]],
  reports: [],
  declined: 2,
  led: "done",
})

test("exit: a service that stopped is asked once, not once per session", {
  steps: [["prompt", A], ["prompt", B], ["service", "down"], ["exit"]],
  reports: ["ses_A working", "ses_B working"],
  declined: 1,
})

// ------------------------------------------------------------------ runner

const compact = (body) => {
  const { state, kind, msg } = body.status
  return `${body.scope.replace(/^opencode-/, "")} ${state}${kind ? `/${kind}` : ""}${msg ? ` (${msg})` : ""}`
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function script(dir, name, body) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  if (body) writeFileSync(file, body)
  else copyFileSync(FAKE_CLI, file)
  chmodSync(file, 0o755)
  return file
}

async function run(t) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-sidepulse-"))
  const fake = join(dir, "fake")
  const home = join(dir, "home")
  const bin = join(dir, "bin")
  const volumes = join(dir, "volumes")
  for (const made of [fake, home, bin, volumes]) mkdirSync(made)

  const service = t.service ?? "up"
  if (service === "up") writeFileSync(join(fake, "up"), "")
  if (t.hang) writeFileSync(join(fake, "hang"), "")

  const volume = t.volume === undefined ? "SidePulse" : t.volume
  const led = join(volumes, volume ?? "none", "LEDS.LED")
  if (volume) {
    mkdirSync(join(volumes, volume))
    if (t.ledFile !== false) writeFileSync(led, LED.untouched)
    const keepalive = join(volumes, volume, "keepalive")
    writeFileSync(keepalive, "")
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(keepalive, old, old)
  }

  // A decoy records that it ran. It answers 0 so a wrong lookup also loses the reports.
  const decoy = `#!/bin/sh\ncat > /dev/null\n: > "${join(fake, "decoy-ran")}"\n`
  const env = { ...process.env, ...t.env, HOME: home, SIDEPULSE_VOLUMES: volumes, FAKE_SIDEPULSE_DIR: fake }
  delete env.SIDEPULSE_BIN
  delete env.XDG_STATE_HOME
  const cli = service === "none" ? "none" : (t.cli ?? "env")
  if (cli === "none") env.SIDEPULSE_BIN = join(dir, "missing", "sidepulse")
  if (cli === "env") env.SIDEPULSE_BIN = FAKE_CLI
  if (cli === "home") script(join(home, ".local", "bin"), "sidepulse")
  if (cli === "path") script(bin, "sidepulse")
  if (t.decoy === "home") script(join(home, ".local", "bin"), "sidepulse", decoy)
  if (t.decoy === "path") script(bin, "sidepulse", decoy)
  env.PATH = `${bin}${delimiter}${process.env.PATH}`
  env.SCENARIO = JSON.stringify({ opencode: t.opencode ?? 1, steps: t.steps })
  env.SCENARIO_DIR = dir
  env.SCENARIO_LED = led

  const problems = []
  const child = spawn(process.execPath, [DRIVER], { env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
  const code = await new Promise((resolve) => child.once("close", (status, signal) => resolve(signal ?? status)))
  clearTimeout(timer)
  if (code !== 0) problems.push(`the driver ended with ${code}\n${output.trim()}`)

  // Read at once. Anything the plugin owes the service must be there when the process
  // ends. A detached copy of the last report may still arrive later. It repeats a
  // request_id, so it would not change the lists below.
  const once = (bodies) => {
    const seen = new Set()
    return bodies.filter((body) => !seen.has(body.request_id) && seen.add(body.request_id))
  }
  const bodies = once(lines(join(fake, "reports.jsonl")))
  const declined = once(lines(join(fake, "declined.jsonl")))
  const result = existsSync(join(dir, "result.json")) ? JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) : {}
  const named = (value) => (value in LED ? LED[value] : value)
  const expect = (what, got, want) => {
    if (!isDeepStrictEqual(got, want))
      problems.push(`${what}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`)
  }

  if (t.reports) expect("reports the service applied", bodies.map(compact), t.reports)
  if (t.declined !== undefined) expect("reports the stopped service was given", declined.length, t.declined)
  if (t.leds) expect("LEDS.LED at each look", result.leds, t.leds.map(named))
  if (t.keepalive) expect("keepalive touched at each beat", result.keepalive, t.keepalive)
  const wantLed = t.led === undefined ? (service === "up" && !t.hang ? "untouched" : undefined) : t.led
  if (wantLed !== undefined)
    expect("LEDS.LED at the end", existsSync(led) ? readFileSync(led, "utf8") : null, named(wantLed))
  if (existsSync(join(fake, "decoy-ran"))) problems.push("the wrong CLI was started")
  const custom = t.check?.({ bodies, result })
  if (custom) problems.push(custom)

  if (problems.length && keep) problems.push(`files kept in ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
  return problems
}

const keep = process.argv.includes("--keep")
const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
const chosen = tests.filter((t) => !only || t.name.includes(only))
const names = new Set()
for (const t of tests) {
  if (names.has(t.name)) throw new Error(`two tests are named "${t.name}"`)
  names.add(t.name)
}

// Run a few at a time. Each test has its own folders, so they cannot disturb each other.
const outcomes = new Array(chosen.length)
let next = 0
const workers = Array.from({ length: Math.min(availableParallelism(), 8) }, async () => {
  while (next < chosen.length) {
    const index = next++
    outcomes[index] = await run(chosen[index]).catch((error) => [String(error?.stack ?? error)])
  }
})
await Promise.all(workers)

let failures = 0
chosen.forEach((t, index) => {
  const problems = outcomes[index]
  if (!problems.length) return console.log(`ok      ${t.name}`)
  failures++
  console.log(`FAILED  ${t.name}`)
  for (const problem of problems) console.log(`    - ${problem}`)
})
console.log(`\n${chosen.length - failures} of ${chosen.length} passed`)
if (failures || !chosen.length) process.exitCode = 1
