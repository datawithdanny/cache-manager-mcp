# macOS LaunchAgent for Cache Manager Notifier

Use this when you want `server/cache-manager-notifier.mjs` to run in the background whenever you log in.

## 1. Find paths

Find Node:

```sh
which node
```

Common values are:

```text
/opt/homebrew/bin/node
/usr/local/bin/node
```

Find this repository path:

```sh
pwd
```

## 2. Install the plist

Copy the template:

```sh
mkdir -p ~/Library/LaunchAgents
cp docs/launchagents/com.cache-manager.notifier.plist ~/Library/LaunchAgents/com.cache-manager.notifier.plist
```

Edit the copied plist and replace:

```text
/opt/homebrew/bin/node
/ABSOLUTE/PATH/TO/cache-manager/server/cache-manager-notifier.mjs
```

with your actual Node path and absolute notifier script path.

## 3. Optional click-to-copy notifications

The default LaunchAgent template copies the handoff prompt automatically at the 4-minute idle threshold.

For click-to-copy behavior instead, install `terminal-notifier`:

```sh
brew install terminal-notifier
```

Then edit the copied plist environment variables:

```xml
<key>CACHE_MANAGER_NOTIFY_CLICK_TO_COPY</key>
<string>true</string>
<key>CACHE_MANAGER_NOTIFY_COPY_ON_IDLE</key>
<string>false</string>
```

With this mode, the 4-minute notification stores the handoff prompt in the cache directory and the notification action runs the notifier with `--copy-prompt <session_id>`.

## 4. Load or restart the LaunchAgent

```sh
launchctl unload ~/Library/LaunchAgents/com.cache-manager.notifier.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.cache-manager.notifier.plist
```

Check logs:

```sh
tail -f /tmp/cache-manager-notifier.out.log /tmp/cache-manager-notifier.err.log
```

Stop it:

```sh
launchctl unload ~/Library/LaunchAgents/com.cache-manager.notifier.plist
```

## Notes

- This is an OS-level helper. It does not give the MCP client native in-app notifications.
- It tracks cache-manager heartbeats in `~/.cache/cache-manager-mcp/sessions.json`.
- It cannot create a new chat tab or prefill the client's prompt box.
- macOS may ask for notification permissions for Script Editor, Terminal, or `terminal-notifier`, depending on how the helper is launched.
