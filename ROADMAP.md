# Quokka Bot roadmap

What ships today is in the [README](README.md). Next, roughly in this order:

## iPhone app

- Agents and chat with the same cards as the web app (logins, sites, takeover).
- Push for anything that needs the owner, answered from the notification.
- Live view and takeover, with native fields for one-time codes and passwords that type straight into the agent's
  computer.
- Share sheet: send a PDF, photo or link to an agent.
- Pairing with a self-hosted server by QR code.

## Each agent's own email address

- Receive mail and attachments; mail from unknown senders waits for the owner's approval.
- Send drafts the owner approved, or mail inside a standing permission ("this recipient", "for this task").
- Read email verification codes itself, so fewer sign-ins need the owner.
- Bring your own mailbox over IMAP and SMTP.

## Memory and history

- One continuous conversation per agent instead of a fresh start per task.
- A short memory per agent (accounts, preferences) that the owner can read and edit.
- Search over the agent's own past chats.

## The computer

- Computers sleep when idle and wake when a task, a message or the owner arrives.
- Documents in the chat (PDFs and files, not only images).
- More connectors: Google Calendar and Drive.

## More agents and models

- Other official CLIs next to Claude Code (Codex, Copilot), and API keys.
- Linux and Windows builds of the desktop app; Android after the iPhone app.

## Design rules

- The agent runs the providers' official, unmodified CLIs; Quokka Bot never reads or stores a plan's token.
- An approval screen is not a boundary: every route to an action goes through the control plane or a session the
  owner attends.
- The agent drives the browser through the browser service, never the debugging port (that is cookie access).
- Second factors go to the owner: SMS codes, ID-app confirmations and new-device prompts use takeover.
- Restores must not bring back revoked logins or expired approvals.
- A memory snapshot of a signed-in CLI is a copy of its token, so CLI sign-ins are never backed up.
