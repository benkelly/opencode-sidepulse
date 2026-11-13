// Runs the plugin against a real SidePulse install. Use it to check a SidePulse version:
//
//   SIDEPULSE_BIN=/path/to/sidepulse node test/service.mjs            # a version with `sidepulse report`
//   SIDEPULSE_BIN=/path/to/sidepulse node test/service.mjs --legacy   # a version from before it
//
// The first form starts `sidepulse service run` in a throwaway home folder, drives the
// plugin through fake OpenCode hooks, and reads back what the service shows with
// `sidepulse status`. The second form checks that the plugin falls back to direct mode.
// CI runs both against pinned SidePulse commits and against its main branch.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

const cli = process.env.SIDEPULSE_BIN
if (!cli || !existsSync(cli)) {
  console.error("Set SIDEPULSE_BIN to a real sidepulse CLI.")
  process.exit(2)
}
const legacy = process.argv.includes("--legacy")
const DRIVER = fileURLToPath(new URL("driver.mjs", import.meta.url))
const UNTOUCHED = "untouched\n"
const BUSY = "off\n0:#00ccff 1:#0088cc 2:#004466 3:#001a26\nroll 1.2s linear\nrepeat\n"
const DONE = "#00ff22 0.6s cosine\n"

const dir = mkdtempSync(join(tmpdir(), "opencode-sidepulse-service-"))
const home = join(dir, "home")
const led = join(dir, "volumes", "SidePulse", "LEDS.LED")
mkdirSync(home)
mkdirSync(join(dir, "volumes", "SidePulse"), { recursive: true })
writeFileSync(led, UNTOUCHED)

// The service and the CLI find each other through the home folder, so they share this one.
const env = { ...process.env, HOME: home, SIDEPULSE_BIN: cli, SIDEPULSE_VOLUMES: join(dir, "volumes") }
delete env.XDG_STATE_HOME
delete env.XDG_CONFIG_HOME

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ev = (type, payload = {}) => ["event", type, payload]

let failures = 0
function check(name, got, want) {
  if (isDeepStrictEqual(got, want)) return console.log(`ok      ${name}`)
  failures++
  console.log(`FAILED  ${name}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`)
}

// What the service shows for the given sessions: mode, message and how many reports it applied.
function shown(...sessions) {
  const { stdout } = spawnSync(cli, ["status", "--json", "--all"], { env, encoding: "utf8" })
  const snapshot = JSON.parse(stdout.split("\n")[0])
  const rows = [...snapshot.statuses, ...snapshot.stale_statuses]
  return Object.fromEntries(
    sessions.map((id) => {
      const row = rows.find((candidate) => candidate.session_id === id)
      return [id, row ? `${row.mode} after ${row.seq}` : "absent"]
    }),
  )
}

function drive(opencode, steps) {
  const scenario = mkdtempSync(join(dir, "scenario-"))
  const result = spawnSync(process.execPath, [DRIVER], {
    env: { ...env, SCENARIO: JSON.stringify({ opencode, steps }), SCENARIO_DIR: scenario, SCENARIO_LED: led, FAKE_SIDEPULSE_DIR: scenario },
    encoding: "utf8",
    timeout: 60_000,
  })
  if (result.status !== 0) {
    failures++
    console.log(`FAILED  the driver ended with ${result.status ?? result.signal}\n${result.stdout}${result.stderr}`)
  }
  const file = join(scenario, "result.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { status: [], leds: [] }
}

if (legacy) {
  // A SidePulse from before `sidepulse report`. The command fails, so the plugin must
  // drive the device itself.
  const probe = spawnSync(cli, ["report", "--json"], { env, input: "{}", encoding: "utf8" })
  check("this SidePulse has no report command", probe.status !== 0, true)
  const result = drive(1, [["prompt", "old"], ["led"], ev("session.idle", { sessionID: "old" }), ["led"]])
  check("the plugin writes the device itself", result.leds, [BUSY, DONE])
} else {
  const service = spawn(cli, ["service", "run"], { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  service.stdout.on("data", (chunk) => (log += chunk))
  service.stderr.on("data", (chunk) => (log += chunk))
  const stopped = new Promise((resolve) => service.once("exit", resolve))
  try {
    let up = false
    for (let tries = 0; tries < 150 && !up && service.exitCode === null; tries++) {
      up = spawnSync(cli, ["status", "--json"], { env }).status === 0
      if (!up) await sleep(200)
    }
    if (!up) throw new Error(`the service did not start\n${log}`)

    const a = drive(1, [
      ["prompt", "v1-a"],
      ["status"],
      ev("permission.asked", { sessionID: "v1-a" }),
      ["prompt", "v1-b"],
      ["after", "v1-b", "bash"],
      ["status"],
      ev("permission.replied", { sessionID: "v1-a" }),
      ev("session.status", { sessionID: "v1-a", status: { type: "retry" } }),
      ["status"],
      ev("session.status", { sessionID: "v1-a", status: { type: "busy" } }),
      ["status"],
      ev("session.idle", { sessionID: "v1-a" }),
      ev("session.error", { sessionID: "v1-b", error: { name: "ProviderError" } }),
      ["status"],
    ])
    check("OpenCode 1: what the service shows at each step", a.status, [
      { "v1-a": "working" },
      { "v1-a": "waiting_for_input", "v1-b": "working" },
      { "v1-a": "blocked_error (Retrying a failed provider call)", "v1-b": "working" },
      { "v1-a": "working", "v1-b": "working" },
      { "v1-a": "completed", "v1-b": "blocked_error" },
    ])
    check("OpenCode 1: done and error are kept after the plugin unloads", shown("v1-a", "v1-b"), {
      "v1-a": "completed after 6",
      "v1-b": "blocked_error after 2",
    })

    const b = drive(2, [
      ["prompt", "v2-a"],
      ev("session.execution.started", { sessionID: "v2-a" }),
      ["before", "v2-a", "question"],
      ["status"],
      ["after", "v2-a", "question"],
      ["before", "v2-a", "bash"],
      ["after", "v2-a", "bash"],
      ["status"],
      ev("session.execution.succeeded", { sessionID: "v2-a" }),
      ["status"],
    ])
    check(
      "OpenCode 2: what the service shows at each step",
      b.status.map((status) => status["v2-a"]),
      ["waiting_for_input", "working", "completed"],
    )

    // The plugin sends the report in flight a second time when the process exits. The
    // service must apply it once: three states, three applied reports.
    drive(1, [["fast", [["prompt", "run"], ev("permission.asked", { sessionID: "run" }), ev("session.idle", { sessionID: "run" })]], ["exit"]])
    await sleep(1500)
    check("exit: queued reports arrive in order and a repeat is applied once", shown("run"), { run: "completed after 3" })

    drive(1, [["prompt", "quit-working"], ["prompt", "quit-waiting"], ev("permission.asked", { sessionID: "quit-waiting" }), ["exit"]])
    drive(1, [["fast", [["prompt", "quit-at-once"]]], ["exit"]])
    await sleep(1500)
    check("exit: unfinished sessions are cleared", shown("quit-working", "quit-waiting", "quit-at-once"), {
      "quit-working": "absent",
      "quit-waiting": "absent",
      "quit-at-once": "absent",
    })

    check("the plugin never wrote the device while the service ran", readFileSync(led, "utf8"), UNTOUCHED)
  } finally {
    service.kill()
    await stopped
  }

  const after = drive(1, [["prompt", "late"], ["led"], ev("session.idle", { sessionID: "late" }), ["led"]])
  check("service stopped: the plugin writes the device itself", after.leds, [BUSY, DONE])
}

if (failures) console.log(`\n${failures} failed. Files kept in ${dir}`)
else rmSync(dir, { recursive: true, force: true })
process.exitCode = failures ? 1 : 0
