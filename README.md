<div align="center">

# Girru — Agent OS

### 🧭 Talk to one. Get a whole company.

**🤖 Your AI agents. One team. Unified memory.**

An open-source operating system for AI agents—bringing your agents, models, tools, and projects into one workspace.

**🏠 Local-first · 🛡️ Security-focused · 🔓 Open source**

**Your hardware. Your accounts. Your control.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/providers-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/readme/providers-light.svg">
  <img src="docs/images/readme/providers-light.svg" alt="OpenAI, Claude, Gemini and Ollama" height="30">
</picture>

*Supported provider and local-runtime families. Connection methods vary.*

<p>
  <img src="docs/images/readme/telegram.svg" alt="Telegram" title="Telegram" height="26"> &nbsp;&nbsp;
  <img src="docs/images/readme/whatsapp.svg" alt="WhatsApp" title="WhatsApp" height="26"> &nbsp;&nbsp;
  <img src="docs/images/readme/discord.svg" alt="Discord" title="Discord" height="26"> &nbsp;&nbsp;
  <img src="docs/images/readme/slack.png" alt="Slack" title="Slack" height="26"> &nbsp;&nbsp;
  <img src="docs/images/readme/email.svg" alt="Email" title="Email" height="26"> &nbsp;&nbsp;
  <img src="docs/images/readme/web-chat.svg" alt="Web chat" title="Web chat" height="26">
</p>

<p>
  <img src="docs/images/readme/gdpr-dsgvo.png" alt="GDPR / DSGVO — design target, not certification" height="34">
  <img src="docs/images/readme/eu-ai-act.png" alt="EU AI Act — design target, not certification" height="34">
</p>

*Privacy and AI governance design targets—not certifications.*

**Formerly known as Agent Player.**

**🏗️ Built by Dpro. Building since May 2025.**

[🌐 Website](https://girru.dev/) · [⬇️ Download](https://github.com/Dpro-at/Girru/releases) · [📜 Changelog](https://girru.dev/changelog/) · [🤝 Contribute](CONTRIBUTING.md)

</div>

---

## 🌐 One workspace for your entire AI team

Your project should not start over every time you switch assistants.

Girru brings conversations, knowledge, tasks, tools, and agent roles into a connected workspace. Organise agents into departments, give them specialties and permissions, and choose the supported models they use.

We are building **Agent OS**: the systems agents need to collaborate, preserve context, and carry work from your request to a result you can review.

Our direction connects everyday digital work with creative worlds, simulation, robotics, and electronics.

## 🏠 Talk to one local coordinator

Talk to a local agent that coordinates your team.

Our architecture puts local coordination at the centre: understand your request, select relevant context, apply configured permissions and filtering rules, and delegate work to suitable agents.

Use supported local models alongside connected providers such as OpenAI, Anthropic, and Google. Available connection methods vary by integration and release.

```text
                         You
                          │
                          ▼
                 Local coordinator
                          │
                          ▼
       Permissions · Context selection · Filtering
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         Local agents          Connected providers
              │                       │
              └───────────┬───────────┘
                          ▼
             Results · Tasks · Approvals
                          │
                          ▼
              Controlled shared memory
```

Ask your team:

> “Bring together the design and development departments, review this project, and propose the next steps.”

The goal is one connected workflow: discussion, findings, proposed actions, your approval, and assigned tasks.

Supported local workflows can stay on your machine. External providers receive the permitted context needed for their requests. Coordination and filtering coverage depend on the workflow and installed version.

## 🧠 Unified memory across your AI team

**Explain your project once. Keep its knowledge working for your team.**

We are developing a unified memory system so supported agents and providers can work from consistent context, reducing the need to repeat information and manually update separate assistants.

- 📁 **Project knowledge** — Keep requirements, decisions, preferences, and working context together.
- 🔄 **Continuity across agents** — Build on earlier work across conversations and providers.
- 📥 **Knowledge imports** — Bring supported project documents and local agent memory into Girru.
- ⚙️ **Automatic import controls** — Choose how supported sources are discovered and updated.
- ✏️ **Memory management** — Review, correct, retain, or forget information.
- 🔐 **Controlled sharing** — Share relevant knowledge within defined access boundaries.

**Unified memory does not mean unrestricted access.** Ownership, scope, and permissions remain part of the system.

Cross-provider coverage is expanding. Sharing context does not transfer a provider’s underlying model or change its training.

## 🔑 Use the AI subscriptions you already pay for

**Supported subscription connections require no additional API key or separate API billing.**

Work through supported tools such as **Claude Code** and **Codex**, using your existing Claude or ChatGPT subscription.

API connections and local models remain additional choices.

| Connection | What you use |
|---|---|
| 🔑 **Supported subscription connection** | Your existing subscription, within its usage limits |
| ☁️ **Optional API connection** | Your own API credentials and provider billing |
| 🏠 **Local model** | Your hardware and a supported local runtime |

Provider support and subscription support are different: an integration does not automatically include access through a consumer subscription.

You keep your own accounts. Girru does not resell or share subscriptions. Provider terms and plan limits apply.

## 🛡️ Security first

Connecting agents should preserve your control over information and actions.

Girru’s security approach centres on local operation, separated memory, scoped access, protected credentials, and approval gates.

| Protection | Purpose |
|---|---|
| 🧠 **Memory separation** | Keep private context separate and share within defined boundaries |
| 👤 **Owner-scoped access** | Restrict data access to the appropriate owner |
| 🔐 **Agent permissions** | Control access to tools and resources |
| ✅ **Approval gates** | Require your decision for protected actions |
| 📥 **Controlled imports** | Govern sources and filter sensitive information in supported import paths |
| 🔑 **Credential protection** | Keep secrets behind backend access controls |
| 🧹 **Configured outbound filtering** | Control context forwarded through supported workflows |

Local deployment gives you control over storage and connections. Cloud models and external integrations process the information sent to them.

Filtering operates within its supported scope; it does not guarantee detection of every kind of sensitive information.

Report vulnerabilities through [SECURITY.md](SECURITY.md).

## 🏢 Designed with organisational requirements in mind

Girru is being developed for individuals and organisations that need control over where their AI work runs and how information is shared.

Run supported workflows on your infrastructure, manage access to knowledge and tools, and choose which external services your team uses.

Our privacy and AI governance design targets include:

| Region | Relevant frameworks |
|---|---|
| 🇪🇺 **European Union** | **GDPR / DSGVO · EU AI Act** |
| 🇺🇸 **United States — California** | **CCPA, as amended by CPRA** |
| 🇬🇧 **United Kingdom** | **UK GDPR · DPA 2018 · PECR** |
| 🇨🇭 **Switzerland** | **FADP** |
| 🇨🇦 **Canada** | **PIPEDA**, alongside applicable provincial laws |
| 🇸🇬 **Singapore** | **PDPA** |

These are requirements we aim to support through product design and deployment controls. They are **not certifications or a claim of universal compliance**.

Applicable obligations depend on the organisation, jurisdiction, data, and use case. Local operation alone does not establish compliance.

## 🧰 Ready-to-use systems for capable agents

A productive agent needs context, tools, responsibilities, and a way to organise its work.

Girru brings these foundations together:

| System | What it provides |
|---|---|
| 👥 **Agents and departments** | Teams with defined responsibilities |
| 🎯 **Specialties** | Configuration for particular kinds of work |
| 🎭 **Personalities** | Adjustable working styles and behaviour |
| 🧠 **Memory** | Persistent knowledge and project context |
| 💬 **Conversations** | Connected discussion and work |
| 📋 **Tasks** | Assignments, ownership, and progress |
| 🗓️ **Scheduling** | Planned and recurring workflows |
| ✅ **Approvals** | Owner control over protected decisions |
| 🔌 **Tools and MCP** | Connections to additional capabilities |
| 🧩 **Apps and extensions** | Specialised workflows |
| ⚙️ **Model selection** | Supported models chosen for different agents and tasks |

Availability and configuration vary by release and integration.

## 🤝 Meet with your AI team

Bring selected agents and departments into a shared discussion.

The current development implementation includes:

- 👥 Participants from multiple departments.
- 💬 Shared conversation history, attachments, and model controls.
- 🖥️ A main call or screen stage with a resizable chat sidebar.
- 🎙️ Local speech transcription with automatic pause-detected turns.
- 📷 Camera and screen previews, with image-frame attachments.
- 📋 Meeting summaries you review before proposed actions become tasks.

Ordinary chats, scheduled conversations, and meetings use the same core conversation workspace.

Real-provider voice and vision, camera hardware, and packaged platform acceptance remain under validation. Current voice interaction uses detected speech turns rather than continuous full-duplex provider audio/video streaming.

## 📡 Connect through your channels

Bring conversations into your workspace through supported integrations.

| Channel | Connection |
|---|---|
| ✈️ **Telegram** | Telegram integration |
| 💬 **WhatsApp** | WhatsApp integration |
| 🎮 **Discord** | Discord integration |
| #️⃣ **Slack** | Slack integration |
| ✉️ **Email** | Email integration |
| 🌐 **Web chat** | Browser-based conversations |

Each channel has its own setup, credentials, permissions, and supported operations. Consult the documentation for your installed version.

## 🧩 Extend your workspace

Add capabilities through supported apps, extensions, and MCP integrations.

Specialised areas include:

- 📈 Market tools and trading workflows.
- 🔎 SEO and research.
- 🛡️ Security-related workflows.
- 🖥️ Monitoring and operational tools.
- 🌍 Creative environments and GenVR integration.

Configure what your work requires. Each integration has its own permissions, dependencies, availability, and operating requirements.

## 🌍 GenVR — worlds your agents can work inside

Our GenVR direction connects your AI team with interactive 3D environments.

Build scenes, arrange objects, use your own characters, and develop experiences with your agents. Control scene elements and camera composition using your mouse and keyboard.

The roadmap brings together:

- 🏗️ **World building** — Create environments and arrange their contents.
- 🎭 **3D characters** — Use your characters in stories, scenes, and interactions.
- 🎮 **Interactive experiences** — Develop scenarios, rules, and agent behaviour.
- 🎬 **Virtual production** — Stage, film, edit, and produce creative work.
- 🤖 **Simulation** — Build repeatable environments for testing and learning.

GenVR integration and these workflows are under development.

## 🎬 Create films and series with your own 3D characters

Work with AI to bring your characters and stories to life.

Our production vision combines storytelling, scene construction, character direction, camera work, editing, and output in one connected GenVR environment.

- ✍️ Develop ideas, scripts, episodes, and shot plans with your agents.
- 🎭 Stage scenes around your own 3D characters.
- 🖱️ Position scene elements using mouse and keyboard.
- 🎥 Direct camera angles, movement, and composition.
- ✂️ Build toward integrated editing, sound, titles, and final output.

**From an idea to a scene, and from a scene to a film or series.**

This describes the creative production roadmap. Individual capabilities will be documented as they are implemented and validated.

## 🤖 From virtual experience to physical robots

We want useful knowledge to travel with your agent—from digital work to simulated environments and supported physical devices.

Our robotics direction connects Girru’s memory with GenVR scenarios and hardware-specific integrations.

The intended workflow is to:

1. 🌍 Create scenarios representing real tasks and environments.
2. 🧪 Train or evaluate movement, interactions, and decisions through suitable simulation tools.
3. 🧠 Preserve useful task knowledge and experience.
4. 🔄 Transfer compatible memory, policies, or behaviours to supported robots.
5. ✅ Validate operation on the actual hardware.

This direction includes compatible robots you already own or connect in the future, once the required integration is available.

Simulation-to-real transfer requires appropriate training methods, hardware adapters, and safety validation. Shared memory alone does not provide reliable physical skills.

## 🔧 Electronics, PCB design, and IoT

Our electronics roadmap covers **PCB design, Arduino, Raspberry Pi, sensors, actuators, and IoT devices**.

We aim to connect the workflow:

```text
Circuit and PCB design
         ↓
Firmware development
         ↓
Device connection
         ↓
Agent tools and memory
         ↓
Testing and controlled operation
```

Design the electronics, develop the software, connect the device, and integrate it with your agent’s working environment.

Integrated electronics and general robotics support are roadmap work, not capabilities guaranteed by the current release.

## 🚧 Project status

Girru is actively developed. Source branches and local previews can contain capabilities not yet included in published installers.

| Area | Current position |
|---|---|
| 👥 **Agent workspace, conversations, tasks, memory, and configuration** | Implemented; actively improved |
| 🔑 **Supported subscription, API, and local-model connections** | Available; setup varies |
| 🧠 **Unified memory, source discovery, and automatic imports** | Foundations implemented; coverage and validation expanding |
| 🤝 **Meetings and automatic voice turns** | Development implementation; acceptance ongoing |
| 🏠 **Local coordination and outbound filtering** | Coverage depends on workflow, integration, and release |
| 🌍 **GenVR creative production and simulation** | In development |
| 🤖 **Robotics transfer and integrated electronics** | Roadmap |

See the [changelog](https://girru.dev/changelog/) and release notes for the capabilities and limitations of each version.

## 💻 Get Girru

Visit the **[Releases page](https://github.com/Dpro-at/Girru/releases)** for published installers and platform-specific notes.

For setup instructions, see the [installation guide](docs/INSTALLATION.md).

For source development, start with [CONTRIBUTING.md](CONTRIBUTING.md).

## 🗓️ Building since May 2025

Girru began as **Agent Player** on **30 May 2025**. It later became **Girru**, continuing the same project and its vision for an Agent OS.

The first release, **v0.1.0**, followed on **20 July 2025**.

Development continues toward a connected Agent OS for knowledge, collaboration, tools, and interaction with virtual and physical environments.

Explore the [project timeline and releases](https://girru.dev/changelog/).

## 🤝 Build with us

Girru is free and open source.

Contributions are welcome across development, integrations, testing, documentation, translations, accessibility, and design.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

💡 Have an idea or found a problem? [Open an issue](https://github.com/Dpro-at/Girru/issues).

🛡️ For security concerns, follow [SECURITY.md](SECURITY.md).

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Dpro-at/Girru&type=Date)](https://www.star-history.com/#Dpro-at/Girru&Date)

## 👤 Creator

**[9MTM](https://github.com/9mtm)** — Creator & Lead Developer

**Built by [Dpro](https://dpro.at/en/). Building since May 2025.**

## ⚖️ License

MIT — see [LICENSE](LICENSE).

Third-party components retain their respective licences. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

---

<div align="center">

### 🤖 Girru — Agent OS

**One team. Unified memory. Your control.**

[🌐 Website](https://girru.dev/) · [💻 GitHub](https://github.com/Dpro-at/Girru) · [🏢 Dpro](https://dpro.at/en/)

</div>
