# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's **private vulnerability reporting** on this repository (Security tab, "Report a vulnerability"). Include the version, your editor and OS, and steps to reproduce. You will get a reply within a few days.

## What is in scope

- Anything that lets content from a model, a file or a webview message cause an action the user did not approve: writing or deleting files outside the workspace, running a program, passing options to `git`, script injection in the webview.
- A way to make the extension read or send credentials.

## Threat model in short

- The extension starts the `claude` and `agent` CLIs as child processes and renders their output. It never calls a model API and never reads or stores credentials.
- Output from agents is untrusted: it is escaped before rendering, links are limited to `https:` and workspace-relative paths, and the webview runs under a strict content security policy.
- Review (Accept / Reject / Undo) only touches files inside the workspace and only paths git reports as changed.
- **Out of scope:** what an agent does when you let it (the **Auto** mode bypasses permission prompts by design), and prompt injection that persuades an agent to act within the permissions you gave it. Use **Ask first** for code you do not trust.
