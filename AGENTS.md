# Agent notes

## Release and preview workflow

This is a Windows Electron app. The last locally tagged release is currently `v0.1.2`; confirm the actual release tag before preparing a new preview.

Use the commit range to review what changed since the last release:

```powershell
git log --oneline v0.1.2..HEAD
git diff --stat v0.1.2..HEAD
```

For a local desktop preview, run the checks and package an installer:

```powershell
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run package
```

Install the generated `Notion-Tasks-Setup-<version>.exe` from `release/<version>/` in a separate Windows profile or VM. `npm run dev` previews the actual Electron app; `npm run preview` only serves the Vite renderer and does not exercise native APIs, tray behavior, or updates.

## Running stable and preview builds side by side

Preview installers are intentionally a separate Windows app. `electron-builder.preview.json` uses the preview app ID `com.notiontasks.desktop.preview`, the product name `Notion Tasks Preview`, a separate installer name, and `release-preview/<version>/` output. The runtime also uses a separate `Notion Tasks Preview` user-data directory. This lets the stable and RC apps remain installed and open at the same time without sharing settings, credentials, caches, favorites, or single-instance locks.

On a prerelease branch whose package version is `0.1.5-rc.1`, build the side-by-side preview installer with:

```powershell
npm run package:preview
```

Install `release-preview/0.1.5-rc.1/Notion-Tasks-Preview-Setup-0.1.5-rc.1.exe`. The stable app remains the normal `Notion Tasks` installation. For source development, use `npm run dev` for the stable identity and `npm run dev:preview` for a separate preview data directory. To run both source versions concurrently, use separate Git worktrees or checkouts; one working directory cannot represent two branches at once.

There is deliberately no in-app version switch. Switching a running installed app would require downloading and replacing the executable, changing update channels, and migrating application state. Side-by-side app identities are safer and make it possible to compare stable and RC behavior directly.

## GitHub preview releases

Use a semver prerelease version for a preview, such as `0.1.5-rc.1`. The package version and tag must match exactly:

```powershell
npm version 0.1.5-rc.1 --no-git-tag-version
npm run validate:release -- v0.1.5-rc.1
git add package.json package-lock.json
git commit -m "Prepare 0.1.5-rc.1 preview"
git tag v0.1.5-rc.1
git push origin HEAD v0.1.5-rc.1
```

The tag workflow validates the version, runs typechecking, unit tests, and the production build, then publishes the Windows installer through electron-builder. A version containing a prerelease suffix is published with the preview app identity and as a GitHub prerelease; a plain version is published as the stable app. The workflow uploads the installer, blockmap, and update metadata.

Stable builds keep `allowPrerelease` disabled. Preview builds enable it based on their own version suffix, so stable users do not receive release candidates. Do not change this rule globally or publish a preview as a normal stable release.

Do not push tags, publish releases, or modify an existing release unless the user explicitly asks for that external action. Local packaging and validation are safe preparation steps.
