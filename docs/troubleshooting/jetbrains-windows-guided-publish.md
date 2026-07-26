# JetBrains Windows terminal failure during Guided Publish

## Status

Guided Publish is blocked in JetBrains terminals on Windows. This is a compatibility guard, not a root-cause fix.
Explicit `revpack publish <command>` subcommands remain available because they do not start the TUI.

The failure was investigated on 2026-07-26 with:

- IntelliJ IDEA 2026.2.0.1, build `IU-262.8665.337`
- Windows 11
- PowerShell launched through JetBrains' `powershell-integration.ps1`
- JetBrains `WinConPtyProcess`
- `TERMINAL_EMULATOR=JetBrains-JediTerm`

Both the Reworked 2025 and Classic terminal engines were reported to fail. The same PowerShell and revpack workflow
worked in Windows Terminal.

## Symptom

The Guided Publish TUI can be navigated normally. Leaving a prompt with Escape works. Completing a prompt with Enter
can make the whole IntelliJ terminal session disappear. With **Close session when it ends** disabled, IntelliJ leaves
the terminal visible with:

```text
[Session completed]
[Process finished with exit code unknown]
```

One deterministic path was the stale-bundle prompt:

1. Start Guided Publish with a stale review bundle.
2. Move the selection to **Cancel**.
3. Press Enter.
4. Revpack prints `Publishing cancelled. No drafts were changed.`
5. IntelliJ ends the terminal session.

This path returns before `orchestrator.prepare()` is called, so provider access and bundle refresh are not required to
trigger the failure.

## Minimal reproduction

The built TUI module reproduces the failure without Commander, provider access, repository discovery, or publishing:

```powershell
node --input-type=module -e "const m=await import('./dist/cli/commands/publish-tui.js'); const choice=await m.runStalePublishPrompt(); console.log('choice='+choice)"
```

Select **Cancel** with Down and Enter. Pressing Escape instead was successful during the investigation.

Keeping the Node child alive for two seconds after the prompt returned did not prevent the failure:

```powershell
node --input-type=module -e "const m=await import('./dist/cli/commands/publish-tui.js'); const choice=await m.runStalePublishPrompt(); console.log('choice='+choice+'; waiting'); await new Promise(r=>setTimeout(r,2000)); console.log('child exiting')"
```

The reproduction requires a human keypress and the IntelliJ terminal host, so the normal unit-test environment cannot
detect the host failure.

## Controls that did not reproduce or explain the failure

- Entering and leaving the alternate screen by itself succeeded.
- A one-key Node raw-mode/readline probe succeeded with both Enter and Escape.
- Invoking `revpack.cmd` instead of npm's PowerShell launcher still failed on Enter.
- Disabling IntelliJ's **Close session when it ends** exposed the completed-session message but did not preserve a
  usable session.
- Delaying completion of the standalone TUI process did not prevent the failure.
- Escape cancellation worked.

These results rule out refresh, provider publishing, the npm PowerShell launcher, raw mode alone, and alternate-screen
mode alone. They do not isolate which combination of redraw, alternate-buffer, keypress, cleanup, and JetBrains shell
integration is load-bearing.

## IntelliJ evidence

At the reproduction timestamp, `idea.log` recorded repeated unhandled Event Dispatch Thread exceptions:

```text
startOffset must be less or equal to endOffset
at com.intellij.openapi.editor.impl.view.LineLayout.getFragmentsInVisualOrder(...)
at com.intellij.openapi.editor.impl.softwrap.mapping.SoftWrapApplianceManager.recalculateSoftWraps(...)
```

Later exceptions reported folding offsets whose start was greater than their end. A new `WinConPtyProcess` terminal
session was logged shortly afterward. This is strong evidence of an IntelliJ editor/terminal model failure, but the
log does not prove that the offset exception directly terminates the PTY.

A related JetBrains issue describes invalid terminal command-block offsets and decoration state:
[IJPL-218952](https://youtrack.jetbrains.com/projects/IJPL/issues/IJPL-218952/Terminal-command-separators-are-not-enabled-ISE-at).
It is not confirmed to be the same defect.

## Relevant revpack terminal lifecycle

`NodePublishTerminal` in `src/cli/commands/publish-tui.ts`:

1. Enables raw stdin and resumes the stream.
2. Enters the alternate screen with `ESC[?1049h`.
3. Hides the cursor.
4. Redraws frames with `ESC[2J` and `ESC[H`.
5. On exit, restores raw mode and the previous input-flow state.
6. Shows the cursor and leaves the alternate screen with `ESC[?1049l`.

The current leading hypothesis is that completing a JetBrains PowerShell command block with Enter while this
full-screen lifecycle is restored corrupts terminal/editor offsets or PTY state. The individual terminal operations
were not sufficient to reproduce the failure in isolation.

## Current mitigation

Bare `revpack publish` checks for:

```text
process.platform === "win32"
TERMINAL_EMULATOR === "JetBrains-JediTerm"
```

When both match, revpack stops before reading the active bundle and directs the user to Windows Terminal. Keep the
guard narrowly scoped: do not block explicit publish subcommands, non-Windows JetBrains terminals, or other Windows
terminal emulators.

## Revisit and removal checklist

Before weakening or removing the guard:

1. Retest the minimal reproduction in the latest stable IntelliJ IDEA on Windows.
2. Test both current JetBrains terminal engines in newly opened sessions.
3. Test Enter cancellation, Escape cancellation, successful selection, stale refresh, and post-publish refresh.
4. Check `idea.log` for terminal, editor-offset, soft-wrap, folding, and PTY exceptions.
5. Test whether disabling command separators or PowerShell shell integration changes the result.
6. Isolate terminal operations with a custom `PublishTerminal`, especially frame clearing versus alternate-screen use.
7. Search JetBrains YouTrack for a fixed issue matching the recorded exception and attach this minimal reproduction
   if no issue exists.
8. Retain the guard until both the standalone reproduction and the complete publish flow return to a usable
   PowerShell prompt after Enter.
