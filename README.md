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
2. Add the string "opencode-sidepulse" to the top-level "plugin" array. The value is an
   array of strings. Create the array if it is absent. Keep every existing entry.
3. Make sure that exactly one sidepulse entry loads. Check
   ~/.config/opencode/plugins/, ~/.config/opencode/plugin/, .opencode/plugins/ and
   .opencode/plugin/ for any file that writes to LEDS.LED. Delete any copy you find,
   because two instances mean two writers fighting over the device.
4. Show me the diff, then tell me to quit and restart opencode.

Do not change any other config field.
```

### Option 2: edit the config yourself

Add the plugin to `opencode.json` or `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sidepulse"]
}
```

opencode installs the package from npm at startup, so you do not run `npm install`.

Quit opencode and start it again. opencode loads config once at startup.

Keep exactly one sidepulse entry. opencode auto-loads every `.ts` and `.js` file in
`.opencode/plugins/` and `~/.config/opencode/plugins/`, so a copy left there loads a
second instance and the two fight over the device.

## What the LEDs mean

| LEDs | Meaning |
| --- | --- |
| Cyan comet | The agent thinks or runs a tool. |
| Amber breathing | A permission prompt waits for you. |
| Solid green | The turn finished. |
| Red breathing | The turn failed. |
| Very dim breathing | You aborted the turn. |

The green hold stays until the next turn starts. The device holds the last program, so the
plugin needs no timer to keep the color.

## Two modes

The SidePulse menu-bar app also writes the LED control file. Two writers on one file
conflict, and the device restarts its animation on every write. This plugin avoids the
conflict. It picks a mode for each event:

| Mode | Condition | Behavior |
| --- | --- | --- |
| App | The app event socket answers. | Send a hook event. Never touch `LEDS.LED`. |
| Direct | No socket answers. | Write an LED program to `LEDS.LED`. |

Only one process ever writes the device.

In app mode the app owns the display. The app aggregates opencode together with Codex,
Claude, and Grok, and it shows the most actionable state across all of them. The plugin
sends these upstream event names:

| Plugin signal | `hook_event_name` | App mode |
| --- | --- | --- |
| Turn start | `UserPromptSubmit` | Working |
| Tool start | `PreToolUse` | Tool Running |
| Tool end | `PostToolUse` | Working |
| Permission prompt | `PermissionRequest` | Waiting For Input |
| Failure | `PostToolUseFailure` | Blocked / Error |
| Finished | `Stop` | Completed |
| Aborted | `SessionEnd` | Completed |

The app needs no patch. Its ingest path accepts any provider name, so `opencode` appears
as a normal agent. `HOOK_PROVIDERS` in the upstream package only limits CLI arguments.

Direct mode needs no Python and no app. The device exposes its controller as a file, so a
file write is the whole interface.

## Requirements

- macOS.
- opencode.
- A SidePulse Pro or SidePulse Dot.

The plugin needs no dependencies and no build step. It uses only Node standard library
modules, so it runs the same under any opencode runtime.

## Test it

From a clone of this repository, under `node` or `bun`:

```sh
node plugin.mjs          # program limits, state machine, device and socket discovery
node plugin.mjs --send   # send one test event to a running app, and report delivery
node plugin.mjs --demo   # walk every LED state on the real device, four seconds each
```

Use `--send` whenever you change the socket transport. App mode falls back to direct mode
on any failure, so a broken transport is otherwise invisible.

Without a clone, check that the published package imports:

```sh
bunx --package opencode-sidepulse bun -e \
  'import("opencode-sidepulse").then(m => console.log(Object.keys(m).join(",")))'
# SidePulse,default
```

That confirms the package only. Use a clone for the self-check and the demo.

The LED language has no error channel. A program that fails to parse blinks all LEDs red
six times. Watch the device during `--demo` to confirm each state.

## Known limits

- Direct mode tracks one state for all sessions. Run the menu-bar app if you need true
  per-session aggregation.
- In direct mode the plugin touches `keepalive` once a minute. The MacBook SD card reader
  cuts power to the device after three minutes of inactivity. The device therefore goes
  dark a few minutes after you quit opencode. In app mode the app owns the keepalive.
- The device ignores LED indexes above its LED count. The programs target LEDs 0 to 3, so
  they work on the eight-LED Pro and degrade on the two-LED Dot.

## Credits

SidePulse and its LED language come from [inteliwear/sidepulse](https://github.com/inteliwear/sidepulse) (MIT).
This plugin is an independent client of the documented file and socket interfaces.

## License

MIT
