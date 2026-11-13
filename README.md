# opencode-sidepulse

[![npm](https://img.shields.io/npm/v/opencode-sidepulse)](https://www.npmjs.com/package/opencode-sidepulse)
[![license](https://img.shields.io/npm/l/opencode-sidepulse)](LICENSE)

Show opencode agent status on a [SidePulse](https://sidepulse.io) Pro or Dot LED device.

The device sits in a MacBook SD card slot or a USB-C port. The LEDs tell you whether the
agent works, waits for your approval, failed, or finished. You do not need to watch the
terminal.

npm package: [`opencode-sidepulse`](https://www.npmjs.com/package/opencode-sidepulse). No
dependencies and no build step.

## Install

### Option 1: let opencode do it

Paste this prompt into an opencode session:

```text
Install the opencode-sidepulse plugin for me.

1. Find my opencode config. Prefer the global file at
   ~/.config/opencode/opencode.json or ~/.config/opencode/opencode.jsonc. Create the
   global file if neither exists, with only {"$schema": "https://opencode.ai/config.json"}.
2. Add the string "opencode-sidepulse" to the top-level plugin array. The key is
   "plugins" on OpenCode 2 and "plugin" on OpenCode 1. Run `opencode --version` to find
   the version. Create the array if it is absent. Keep every existing entry.
3. Make sure that exactly one sidepulse entry loads. Check
   ~/.config/opencode/plugins/, ~/.config/opencode/plugin/, .opencode/plugins/ and
   .opencode/plugin/ for any file that writes to LEDS.LED. Delete any copy you find,
   because two instances mean two writers fighting over the device.
4. Show me the diff, then tell me to quit and restart opencode.

Do not change any other config field.
```

### Option 2: edit the config yourself

On OpenCode 2, run this command:

```sh
opencode plugin add opencode-sidepulse
```

On OpenCode 1, add the plugin to `opencode.json` or `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sidepulse"]
}
```

OpenCode 2 uses the key `plugins` in place of `plugin`.

opencode installs the package from npm at startup, so you do not run `npm install`.

Quit opencode and start it again. opencode loads config once at startup.

Keep exactly one sidepulse entry. opencode auto-loads every `.ts` and `.js` file in
`.opencode/plugins/` and `~/.config/opencode/plugins/`, so a copy left there loads a
second instance and the two fight over the device.

## What the LEDs mean

| LEDs | Meaning |
| --- | --- |
| Cyan comet | The agent thinks or runs a tool. |
| Amber breathing | A permission prompt or a multiple-choice question waits for you. |
| Solid green | The turn finished, or you cancelled it. |
| Red breathing | The turn failed, or opencode is retrying a failed provider call. |

A cancelled turn deliberately looks the same as a finished one. The device is there to
tell you things you cannot see. You already know that you cancelled it.


The green hold stays until the next turn starts. The device holds the last program, so the
plugin needs no timer to keep the color. A failed turn stays red the same way.

## Two modes

The SidePulse background service also writes the LED control file. Two writers on one file
conflict, and the device restarts its animation on every write. This plugin avoids the
conflict. It picks a mode for each status change:

| Mode | Condition | Behavior |
| --- | --- | --- |
| App | `sidepulse report` succeeds. | Report the session status. Never touch `LEDS.LED`. |
| Direct | The command is missing or fails. | Write an LED program to `LEDS.LED`. |

Only one process ever writes the device.

In app mode the service owns the display. It aggregates opencode together with Codex,
Claude, and Grok, and it shows the most actionable state across all of them. The plugin
pipes one [program status](https://github.com/inteliwear/sidepulse/blob/main/docs/protocol/program-status.md)
report to `sidepulse report --json` whenever a session changes state:

| Plugin signal | Reported state | Shown as |
| --- | --- | --- |
| Turn start, tool start, tool end | `working` | Working |
| Permission prompt | `blocked`, kind `permission` | Waiting for Input |
| Multiple-choice question | `blocked`, kind `question` | Waiting for Input |
| Prompt answered | `working` | Working |
| Failure, provider retry | `error` | Blocked / Error |
| Finished, cancelled | `done` | Completed |

A report carries the session ID, the project directory and the state. It never carries
prompts, tool input or tool output.

The plugin reports a session only when its state changes, so a run of tool calls costs
nothing. Reports go out one at a time, in order. Any report still queued when opencode
exits is sent before the process ends, so `opencode run` still finishes green. A session
that is still working or waiting when opencode exits is cleared, because the service never
expires those states by itself.

The plugin looks for the command in `$SIDEPULSE_BIN`, then `~/.local/bin/sidepulse`, then
`PATH`. The service needs no patch: `opencode` appears as a normal agent.

Direct mode needs no Python and no app. The device exposes its controller as a file, so a
file write is the whole interface.

## Requirements

- macOS.
- OpenCode 2, or OpenCode 1.17.20 or newer. Older OpenCode 1 releases are not tested. If
  the plugin does not load on one of them, use `opencode-sidepulse@0.1.7`.
- A SidePulse Pro or SidePulse Dot.
- For app mode, a SidePulse release that has the `sidepulse report` command. Upstream
  added it on 10 November 2026. An older menu-bar app does not understand this plugin and
  both would write the device, so update SidePulse or use `opencode-sidepulse@0.2.0`.

The plugin needs no dependencies and no build step. It uses only Node standard library
modules, so it runs the same under any opencode runtime.

## Test it

From a clone of this repository:

```sh
npm test                 # the self-check, then the regression suite
node plugin.mjs --send   # send one test report through the sidepulse CLI
node plugin.mjs --demo   # walk every LED state on the real device, four seconds each
```

Use `--send` whenever you change the transport. App mode falls back to direct mode on any
failure, so a broken transport is otherwise invisible. The test report clears a session
that does not exist, so it leaves nothing in the menu.

The tests come in four layers. None of them has a dependency to install.

| Command | What it runs against | Needs |
| --- | --- | --- |
| `node test/run.mjs` | A fake `sidepulse` CLI and a folder standing in for the device. Covers both modes, the handover between them, ordering, exit, and event traces recorded from real OpenCode releases. | Nothing |
| `SIDEPULSE_BIN=… node test/service.mjs` | A real SidePulse install. Starts its service and reads back what it shows. Add `--legacy` for a SidePulse from before `sidepulse report`. | SidePulse |
| `OPENCODE_BIN=… node test/opencode.mjs` | A real OpenCode. Runs real turns on one of OpenCode's free models, which need no account. | OpenCode, network |
| `npm run test:mutation` | [Stryker](https://stryker-mutator.io) changes the plugin one piece at a time and reruns the first layer. It fails below 85% caught. | Network, about ten minutes |

The first three also run under `bun`. `test/run.mjs` takes a word to run only the tests
whose name contains it, and `--keep` to keep the files of a failed test.

CI runs all four. `compat.yml` pins the versions it checks:

| Program | Versions |
| --- | --- |
| SidePulse | The commit before `sidepulse report`, the first commit with it, a later one, and `main` |
| OpenCode 1 | 1.18.0 and 1.19.5 |
| OpenCode 2 | 2.1.2, 2.3.0 and the latest release |

The moving entries, SidePulse `main` and the latest OpenCode, also run every Monday. A
breaking change in either program then fails here first. OpenCode releases older than
1.18.0 cannot use the free models, so CI cannot run a turn in them.

When a new OpenCode or SidePulse release changes behaviour, record what it sends, add it
to `test/run.mjs` as a trace, and add the version to `compat.yml`.

Two environment variables exist for the tests. `SIDEPULSE_VOLUMES` replaces `/Volumes` as
the folder searched for the device. `SIDEPULSE_REPORT_TIMEOUT_MS` replaces the five
seconds the plugin waits for the CLI.

Without a clone, check that the published package imports:

```sh
bunx --package opencode-sidepulse bun -e \
  'import("opencode-sidepulse").then(m => console.log(Object.keys(m).join(","), m.default.id))'
# default opencode-sidepulse
```

That confirms the package only. Use a clone for everything else.

The LED language has no error channel. A program that fails to parse blinks all LEDs red
six times. Watch the device during `--demo` to confirm each state.

## Known limits

- Direct mode tracks one state for all sessions. Run the SidePulse service if you need
  true per-session aggregation.
- If opencode is killed mid-turn, the plugin cannot clear its sessions. They stay in the
  SidePulse menu as Working until the service restarts.
- App mode does not name the running tool. The service draws a running tool the same way
  as Working.
- In direct mode the plugin touches `keepalive` once a minute. The MacBook SD card reader
  cuts power to the device after three minutes of inactivity. The device therefore goes
  dark a few minutes after you quit opencode. In app mode the service owns the keepalive.
- The device ignores LED indexes above its LED count. The programs target LEDs 0 to 3, so
  they work on the eight-LED Pro and degrade on the two-LED Dot.

## Credits

SidePulse and its LED language come from [inteliwear/sidepulse](https://github.com/inteliwear/sidepulse) (MIT).
This plugin is an independent client of the documented file and status report interfaces.

## License

MIT
