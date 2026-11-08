---
name: json-render
description: "Generate rich interactive UI specs that render as React components in the chat interface. Use when the user asks for charts, tables, dashboards, metrics, comparisons, timelines, or any structured data visualization. Output a ```spec block after your text response."
metadata:
  agent-player:
    emoji: "🎨"
    version: "1.0.0"
    author: "Dpro"
    category: "utilities"
    tags: ["ui", "charts", "dashboard", "visualization", "components", "spec"]
    triggers:
      - chart
      - table
      - dashboard
      - graph
      - metrics
      - visualization
      - show data
      - spec
      - ui components
    settings: []
    requires:
      llm: true
---

# json-render Skill

Generate rich interactive UI specs rendered as React components in the chat.

## How to Use

After your text response, output a ` ```spec ` block with JSON Patch lines.

## Format

```spec
{"op":"add","path":"/root","value":"ROOT_ID"}
{"op":"add","path":"/elements/ROOT_ID","value":{"type":"COMPONENT","props":{...},"children":["CHILD_ID"]}}
{"op":"add","path":"/elements/CHILD_ID","value":{"type":"COMPONENT","props":{...},"children":[]}}
```

## Quick Component Reference

**Layout**: `Card {title?, description?}` | `Stack {gap:"sm|md|lg", direction:"vertical|horizontal"}` | `Grid {columns:2|3|4, gap}`

**Text**: `Heading {text, level:"h1|h2|h3|h4"}` | `Text {content, muted:bool}` | `Badge {text, variant:"default|secondary|success|warning|destructive"}`

**Data**: `Metric {label, value, detail?, trend:"up|down|neutral"}` | `Table {data:[{...}], columns:[{key,label}]}` | `Callout {type:"info|tip|warning|important", title, content}`

**Rich**: `Timeline {items:[{title,description?,date?,status:"completed|current|upcoming"}]}` | `Accordion {items:[{title,content}]}`

**Charts**: `BarChart {title?, data:[{...}], xKey, yKey}` | `LineChart {title?, data:[{...}], xKey, yKey}` | `PieChart {title?, data:[{...}], nameKey, valueKey}`

**Interactive**: `Tabs {tabs:[{value,label}]} + TabContent {value}` | `Button {label, variant}` | `Link {text, href}`

See [components.md](references/components.md) for full props and examples.

## Example — 4 Metrics Grid

```spec
{"op":"add","path":"/root","value":"g"}
{"op":"add","path":"/elements/g","value":{"type":"Grid","props":{"columns":4,"gap":"md"},"children":["c1","c2","c3","c4"]}}
{"op":"add","path":"/elements/c1","value":{"type":"Card","props":{"title":"Revenue"},"children":["m1"]}}
{"op":"add","path":"/elements/m1","value":{"type":"Metric","props":{"label":"Total","value":"$42K","trend":"up"},"children":[]}}
{"op":"add","path":"/elements/c2","value":{"type":"Card","props":{"title":"Users"},"children":["m2"]}}
{"op":"add","path":"/elements/m2","value":{"type":"Metric","props":{"label":"Active","value":"1,234","trend":"up"},"children":[]}}
{"op":"add","path":"/elements/c3","value":{"type":"Card","props":{"title":"Tasks"},"children":["m3"]}}
{"op":"add","path":"/elements/m3","value":{"type":"Metric","props":{"label":"Done","value":"89%","trend":"neutral"},"children":[]}}
{"op":"add","path":"/elements/c4","value":{"type":"Card","props":{"title":"Errors"},"children":["m4"]}}
{"op":"add","path":"/elements/m4","value":{"type":"Metric","props":{"label":"Today","value":"3","trend":"down"},"children":[]}}
```

## Shared display contract

The shared renderer supports the 61 types described by the explicitly granted `display_catalogue` tool. Use its list/validate actions to inspect current props and validate supplied data. The tool never saves a report, fetches a source, executes a button or grants permission. If no catalogue tool is granted, follow the display subset advertised by the current chat system prompt; do not invent capabilities. Existing core prompt composition is not changed by this display migration.

Use real supplied data only. Full `{schemaVersion:1,root,elements}` documents and bounded JSON Patch streams are supported. Unknown components show an explicit unavailable state. Form controls change local presentation only. Buttons, dialogs, support actions and media/avatar slots require explicit host adapters and their existing permission/approval checks; never imply OTPDisplay verifies a login or a confirmation card grants an approval. Saved Reports are display snapshots, not source refresh requests.
