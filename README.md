# opencode-sidepulse

Show opencode agent status on a [SidePulse](https://sidepulse.io) Pro or Dot LED device.

The device sits in a MacBook SD card slot or a USB-C port. The LEDs tell you whether the
agent works, waits for your approval, failed, or finished. You do not need to watch the
terminal.

## Install

Add the plugin to `opencode.json` or `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sidepulse"]
}
```

Quit opencode and start it again. opencode loads config once at startup.

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
- opencode. App mode uses `Bun.connect`, which the opencode runtime provides.
- A SidePulse Pro or SidePulse Dot.

The plugin needs no dependencies and no build step.

## Test it

```sh
bun plugin.mjs          # program limits, state machine, device and socket discovery
bun plugin.mjs --demo   # walk every LED state on the real device, four seconds each
```

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
