# Ink OS Desktop

Desktop host for the shared Ink OS platform. Local instances have separate persistent directories and start with zero apps. Remote instances use the same web desktop.

For development, place the platform checkout next to this repository, install its dependencies, and build it. Then:

```sh
npm ci
npm start
```

`INK_OS_PLATFORM_DIR` selects another platform checkout. `INK_OS_REMOTE_URL` opens a hosted HTTPS instance. The local host generates private credentials and authenticates its window automatically.

Native execution and distributable packaging are under development. The web baseline remains available independently of native toolchains.
