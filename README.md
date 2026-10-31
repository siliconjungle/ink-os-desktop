# Ink OS Desktop

Desktop host for the shared Ink OS platform. Local instances have separate persistent directories and start with zero apps. Remote instances use the same web desktop.

For development, place the platform checkout next to this repository, install its dependencies, and build it. Then:

```sh
npm ci
npm start
```

`INK_OS_PLATFORM_DIR` selects another platform checkout. `INK_OS_REMOTE_URL` opens a hosted HTTPS instance. The local host generates private credentials and authenticates its window automatically.

The first development launch downloads the pinned Electron runtime if it is missing. `INK_OS_DESKTOP_DATA_DIR` selects a separate private profile. Local profiles keep their address across restarts so browser storage remains available. Reopening a window reuses its host; quitting drains background work before stopping an owned host. A surviving host is authenticated and reconnected without starting another writer.

Ink apps use the shared platform's JavaScript runtime by default. Explicit native builds are exposed through its API, CLI and SDK; a compatible cached native artifact can run without an installed compiler. On macOS arm64/x64, an explicit native build can install the pinned official Rust/Cargo components into the private instance profile. Startup and status never download them. Apple Command Line Tools or Xcode must already provide clang and the macOS SDK; JavaScript remains available when native prerequisites are missing. The installer checks archive hashes, retains upstream notices and leaves system Rust, Cargo and PATH unchanged. Managed installation is currently limited to macOS; standalone platform hosts can use a configured system toolchain.

Build a desktop package with `npm run package`. The builder takes the exact platform revision in `platform.json` from the selected platform checkout, installs its locked dependencies in an isolated workspace, and builds the shared interface. It includes Electron, the platform runtime, the Ink compiler, production dependencies, Git core and its corresponding source/build recipe. The installed app does not need Node or Git installed separately. Fresh instances contain zero apps.

macOS builds produce a drag-to-Applications DMG. Linux builds produce a portable archive; Linux graphical validation and Windows packaging are pending. Local macOS builds use an ad hoc signature. Set `INK_OS_MAC_SIGN_IDENTITY` for a developer identity and optionally `INK_OS_MAC_NOTARY_PROFILE` for an existing Keychain notarization profile. Signing and verification failures stop the build. Credentials stay outside package manifests and source history.

The packaged CLI is `Ink OS.app/Contents/Resources/ink-os` on macOS and `ink-os` beside the executable on Linux. It uses the desktop's local profile automatically; `INK_OS_CONFIG` selects another CLI connection. It can initialize/build/deploy Ink apps and use the same command, workflow and data APIs as the web version. For example:

```sh
"/Applications/Ink OS.app/Contents/Resources/ink-os" init ./my-app --slug my-app
"/Applications/Ink OS.app/Contents/Resources/ink-os" deploy ./my-app
```

`npm run verify:package -- release/BUILD/release.json` checks the artifact hash and macOS code signature, then runs its bundled host and CLI with external development tools blocked. It verifies an empty catalog, explicit Ink source deployment and persistent state after restart. `release.json` records platform/desktop provenance and artifact hashes. The embedded manifest inventories inputs before code signing; signing may change native binaries. Generated staging directories have explicit retention records.

The managed installer passed actual macOS arm64 CI: official archive verification, compiler execution, Rust smoke build, cross-engine Ink state and cache reuse. The owner API cold-cache path and an updated packaged release are separate validation gates. The previously published development DMG predates this source update. Automatic updates and notarized distribution remain unfinished.
