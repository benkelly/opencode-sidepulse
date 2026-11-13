// Runs real turns in a real OpenCode with the plugin loaded. Use it to check an OpenCode
// version:
//
//   OPENCODE_BIN=/path/to/opencode node test/opencode.mjs
//
// OpenCode offers free models that need no account, so this needs no credentials. It does
// need the network. Each run sends two short prompts to a free model. Set OPENCODE_MODEL
// to choose the model, for example opencode/big-pickle.
//
// Everything OpenCode writes goes to a throwaway home folder. The plugin is loaded from
// the global plugins folder, the fake `sidepulse` CLI stands in for the service, and a
// folder stands in for the device. CI runs this against pinned OpenCode releases and
// against the latest one.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

const bin = process.env.OPENCODE_BIN ?? "opencode"
const here = fileURLToPath(new URL(".", import.meta.url))
const LED = {
  untouched: "untouched\n",
  error: "off\n#ff2000 0.9s pulse\nrepeat\n",
  done: "#00ff22 0.6s cosine\n",
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-sidepulse-live-")))
const home = join(dir, "home")
const project = join(dir, "project")
const fake = join(dir, "fake")
const led = join(dir, "volumes", "SidePulse", "LEDS.LED")
for (const made of [project, fake, join(dir, "volumes", "SidePulse"), join(home, ".config", "opencode", "plugins")])
  mkdirSync(made, { recursive: true })
copyFileSync(join(here, "..", "plugin.mjs"), join(home, ".config", "opencode", "plugins", "sidepulse.js"))

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  // OpenCode 1 takes the project directory from PWD, not from the working directory.
  PWD: project,
  SIDEPULSE_BIN: join(here, "fake-sidepulse"),
  SIDEPULSE_VOLUMES: join(dir, "volumes"),
  FAKE_SIDEPULSE_DIR: fake,
}

// stdin is closed on purpose. OpenCode 1 reads a piped stdin as part of the prompt and
// waits on an open one for ever.
const opencode = (args, timeout = 60_000) =>
  spawnSync(bin, args, { env, cwd: project, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })

const version = opencode(["--version"]).stdout?.match(/\d+\.\d+\.\d+/)?.[0]
if (!version) {
  console.error(`Could not run ${bin}. Set OPENCODE_BIN to a real opencode.`)
  process.exit(2)
}
// The flags differ between releases, so ask this one what it has. OpenCode 1 prints help
// to stderr.
const helpRun = opencode(["run", "--help"])
const help = `${helpRun.stdout ?? ""}${helpRun.stderr ?? ""}`
const flags = ["--standalone", "--auto"].filter((flag) => help.includes(flag))
// OpenCode 2 starts a shared background service unless told to keep its server private.
// A service left behind would outlive this test, so every call here stays private.
const standalone = flags.filter((flag) => flag === "--standalone")

const free = (opencode(["models", ...standalone]).stdout ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("opencode/"))
  .sort((a, b) => b.includes("big-pickle") - a.includes("big-pickle"))
const models = process.env.OPENCODE_MODEL ? [process.env.OPENCODE_MODEL] : free.slice(0, 4)
console.log(`OpenCode ${version}, flags ${flags.join(" ") || "none"}, models ${models.join(", ") || "none"}`)

let failures = 0
function check(name, got, want) {
  if (isDeepStrictEqual(got, want)) return console.log(`ok      ${name}`)
  failures++
  console.log(`FAILED  ${name}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`)
}

// One real turn. Returns what the plugin told the service and what the device shows.
function turn(model, prompt, { service }) {
  if (service) writeFileSync(join(fake, "up"), "")
  else rmSync(join(fake, "up"), { force: true })
  for (const log of ["reports.jsonl", "declined.jsonl"]) rmSync(join(fake, log), { force: true })
  writeFileSync(led, LED.untouched)
  const run = opencode(["run", ...flags, "-m", model, prompt], 180_000)
  const read = (log) => {
    const file = join(fake, log)
    const seen = new Set()
    return (existsSync(file) ? readFileSync(file, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((body) => !seen.has(body.request_id) && seen.add(body.request_id))
  }
  const reports = read("reports.jsonl")
  return {
    code: run.status,
    output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n"),
    states: reports.map((body) => body.status.state),
    sessions: [...new Set(reports.map((body) => body.scope))],
    cwds: [...new Set(reports.map((body) => body.context?.cwd))],
    declined: read("declined.jsonl").length,
    led: readFileSync(led, "utf8"),
  }
}

const TASK = "Use your shell tool to run this exact command: echo sidepulse-test. Then reply with the single word ok."

// A free model can be retired or busy, so try a few before calling it a failure.
let model
let finished
for (const candidate of models) {
  finished = turn(candidate, TASK, { service: true })
  if (finished.code === 0) {
    model = candidate
    break
  }
  console.log(`        ${candidate} did not finish a turn (exit ${finished.code}), trying the next model`)
}

if (!model) {
  failures++
  console.log(`FAILED  no free model finished a turn\n${finished?.output ?? "opencode models listed no free model"}`)
} else {
  check(`a real turn on ${model} reports working, then done`, finished.states, ["working", "done"])
  check("the turn is one session", finished.sessions.length, 1)
  check("the session is OpenCode's own", /^opencode-ses_/.test(finished.sessions[0] ?? ""), true)
  check("reports carry the project directory", finished.cwds, [project])
  check("the device is left alone while the service runs", finished.led, LED.untouched)

  const direct = turn(model, TASK, { service: false })
  check("service down: the turn ends green on the device", direct.led, LED.done)
  check("service down: the service was asked, and applied nothing", [direct.declined > 0, direct.states], [true, []])
}

// A model that does not exist fails the turn without any model at all.
const broken = turn("opencode/no-such-model", "Reply ok.", { service: true })
check("a failed turn exits non-zero", broken.code !== 0, true)
check("a failed turn reports working, then error, and stays there", broken.states, ["working", "error"])

const brokenDirect = turn("opencode/no-such-model", "Reply ok.", { service: false })
check("service down: a failed turn ends red on the device", brokenDirect.led, LED.error)

if (failures) console.log(`\n${failures} failed. Last output:\n${broken.output}\nFiles kept in ${dir}`)
else rmSync(dir, { recursive: true, force: true })
process.exitCode = failures ? 1 : 0
