---
name: specialty-library
description: Read, draft and hire with specialties (agent jobs) without changing tools or permissions.
---

# Specialty library

Use the specialty_library MCP tool through the owner's authenticated local session.
Read the specialty and who has it before proposing a change.
A specialty is a job: instructions and skills. It never grants tools, connections, memory or permissions.

- Use the owner's words from the Specialties window: **Give to an agent** (a specialty to an agent), **Take back** (from an agent), **Update N agents** (a saved change that reaches agents who already have it), **Throw the draft away**, **Copy as a new specialty**, **Hire with this** and **Coming soon** (a specialty still being prepared, read-only).
- list/read/catalogue/agents/assigned/impact are read-only. `list` names the agents that have each specialty; `agents` gives each agent's role, department and its real tool access for that job; `assigned` gives one agent's specialties (up to ten).
- Only the owner may save, give, take back or hire. Get an explicit owner instruction before any write.
- Save a draft with its revision (revision 0 and a new uuid id make a new specialty). A specialty no agent has can be saved directly.
- For a specialty agents already have, call preview with the draft and revision and show the owner what changes and which agents get it on their next turn. Only the owner confirms "Update N agents" in the app; this tool never passes a confirmation (`confirmImpact`) and refuses it. On conflict, obtain a new preview.
- Giving a specialty to an existing agent and taking it back are done by the owner in the app, where each step can be undone; this tool refuses them.
- Hire a new agent with a specialty only with `confirmed=true` after the owner checked the job, its tools and what it asks before. Reuse the same requestId when retrying so only one agent is made. Consent to sensitive actions (`confirmRisky`) stays with the owner in the app.
- Tools a job needs are requirements, not access. A tool that is "Not in Girru yet", "Blocked" or "Changed since chosen" stays that way until the owner connects or chooses it again.
- Never invent agents, skills, tool access or completed hires.
- Agents may see a specialty only by its name and the first line of its description, and load its full instructions with `guide_read` when their work needs it. Keep that first line one clear sentence about the job.
