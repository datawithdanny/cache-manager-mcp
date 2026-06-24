# Cache Manager — Zed extension wrapper

The repository root is an **optional** Zed extension that launches the standalone
`cache_manager` MCP server. It is a thin Rust wrapper around the Node server in
`server/cache-manager.mjs`; all functionality lives in that server, which runs in
any stdio-capable MCP client without this extension.

## Install as a Zed dev extension

1. Ensure Node.js is available on your `PATH`.
2. Ensure Rust is installed via `rustup` for Zed dev extensions.
3. In Zed, run `zed: install dev extension`.
4. Select the **repository root** directory, `cache-manager-mcp`.
5. Open the Agent Panel and enable/use the `cache_manager` context server if prompted.

## Path caveat

The dev extension launches `server/cache-manager.mjs`, which resolves when Zed
is pointed at the repository root. A packaged/published extension should launch
the published npm package instead, e.g.:

```rust
Ok(zed::Command {
    command: "npx".into(),
    args: vec!["-y".into(), "@dannyma/cache-manager-mcp".into()],
    env: vec![],
})
```
