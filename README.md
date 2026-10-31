# Ink OS Desktop

Desktop host for the shared Ink OS platform. Local instances have separate persistent directories and start with zero apps. Remote instances use the same web desktop.

For development, place the platform checkout next to this repository, install its dependencies, and build it. Then:

```sh
npm ci
npm start
```

`INK_OS_PLATFORM_DIR` selects another platform checkout. `INK_OS_REMOTE_URL` opens a hosted HTTPS instance. The local host generates private credentials and authenticates its window automatically.

The first development launch downloads the pinned Electron runtime if it is missing. `INK_OS_DESKTOP_DATA_DIR` selects a separate private profile. Local profiles keep their address across restarts so browser storage remains available. Reopening a window reuses its host; quitting drains background work before stopping an owned host. A surviving host is authenticated and reconnected without starting another writer.

Ink apps use the shared platform's JavaScript runtime by default. Explicit native builds are exposed through its API, CLI and SDK; a compatible cached native artifact can run without an installed compiler. Creating native artifacts currently requires Rust and Cargo. Managed toolchains, distributable installers and updates remain under development.
