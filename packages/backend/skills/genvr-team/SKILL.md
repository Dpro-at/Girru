---
name: genvr-team
description: "Coordinate assigned agents working on a GenVR space without overlapping edits"
version: "1.1.0"
author: "Mohamed Alarade"
---

# GenVR team coordination

This is a runtime team guide, adapted from the Genvr project coordination workflow.
It is not permission to administer a repository, run commands, publish, or grant tools.

Identify the assigned space, task owner, requested outcome and available tools first.
Read the current task and handoff before an edit. Claim only your assigned task using
already-authorized board tools. Keep one active task, record progress and verified results,
and do not overwrite another agent's work. Use stable space and agent IDs from current reads.
If concurrent changes conflict, retain the prior version and ask the task owner to reconcile.

Use the GenVR world/character guides only when assigned. Discover actual MCP tools and
respect per-agent grants. A central skill assignment never implies MCP connector access.
Test a small fictional change, save, reopen and read it back before claiming completion.
Label unavailable or untested functions honestly. Do not publish, purchase, change accounts,
install dependencies or send messages unless the user's task and existing permissions allow it.

## Places in Girru (My spaces)

Each place in My spaces has its settings (how it is played, its game, the agents in it), one
Girru chat in its project, and an agent that answers in its Studio chat. With the `genvr_spaces`
tool, when it is granted: `list` and `get` read places; `set_play`, `set_game`, `set_agents` and
`rename` change settings; `set_answerer` chooses who answers in a place's chat; `chat` reads the
place's chat (its latest lines and where it is in Girru Chat); `market` searches the market, which
is the Studio's Items catalog. Building inside a place happens in the Studio while it is open:
the owner asks there, and world changes wait for the owner's OK with Undo.
