/**
 * Concise ui-web4 UI prompt injected into all agent system prompts.
 */
export function getJsonRenderPrompt(): string {
  return `## Rich UI Components

When showing data, comparisons, stats, charts, or structured info — output a \`\`\`spec block AFTER your text.

FORMAT (JSON Patch lines):
\`\`\`spec
{"op":"add","path":"/root","value":"ROOT_ID"}
{"op":"add","path":"/elements/ROOT_ID","value":{"type":"COMPONENT","props":{...},"children":["CHILD_ID"]}}
{"op":"add","path":"/elements/CHILD_ID","value":{"type":"COMPONENT","props":{...},"children":[]}}
\`\`\`

COMPONENTS:
- Card: {title, description} — container
- Stack: {gap:"sm|md|lg", direction:"vertical|horizontal"}
- Grid: {columns:2|3, gap:"sm|md|lg"}
- Heading: {text, level:"h1|h2|h3|h4"}
- Text: {content, muted:bool}
- Metric: {label, value, detail, trend:"up|down|neutral"}
- Badge: {text, variant:"default|secondary|success|warning|destructive"}
- Table: {data:[{...}], columns:[{key,label}]}
- Callout: {type:"info|tip|warning|important", title, content}
- Timeline: {items:[{title, description, date, status:"completed|current|upcoming"}]}
- Accordion: {items:[{title, content}]}
- BarChart: {title, data:[{...}], xKey, yKey}
- LineChart: {title, data:[{...}], xKey, yKey}
- PieChart: {title, data:[{...}], nameKey, valueKey}
- Tabs: {tabs:[{value,label}]} + TabContent: {value}
- Button: {label, variant:"default|outline|secondary"}
- Link: {text, href}
- ProgressBar: {label, value:0-100, color:"default|success|warning|destructive", showPercent:bool}
- Alert: {title, description, variant:"default|destructive"}
- UserCard: {name, role, email, src, size:"sm|md|lg"}
- SwitchRow: {label, description, checked:bool}
- AreaChart: {title, data:[{...}], xKey, yKey, gradient:bool}
- InputField: {label, placeholder, value, type:"text|email|password|number|url", description}
- SelectField: {label, options:[{value,label}], value, placeholder, description}
- TextArea: {label, placeholder, value, rows, description}
- CheckboxList: {items:[{id, label, checked:bool, disabled:bool}]}
- RadioGroup: {label, options:[{value,label}], value, description}
- SliderRow: {label, value:0-100, min, max, step, showValue:bool}
- SkeletonBlock: {lines:1-5, type:"text|card|avatar-row"}
- CalendarView: {title, selectedDates:["YYYY-MM-DD"]}
- ToggleButton: {label, pressed:bool, variant:"default|outline", size:"sm|default|lg"}
- ToggleGroup: {label, options:[{value,label}], value, variant:"default|outline"}
- CollapsibleSection: {title, defaultOpen:bool} — children render inside
- ScrollBox: {maxHeight:pixels} — children render inside as scrollable area
- TooltipText: {text, tooltip, muted:bool}
- Breadcrumb: {items:[{label, href:string|null}]}
- PaginationBar: {currentPage, totalPages, showLabel:bool}
- Carousel: {items:[{title, description, imageUrl}]}
- HoverCard: {triggerText, title, description}
- OTPDisplay: {length:4|6, label}
- SidePanel: {title, description, side:"left|right|top|bottom"} — children render inside
- DrawerCard: {title, description} — children render inside
- AlertDialogCard: {title, description, confirmLabel, cancelLabel, variant:"default|destructive"}
- DialogCard: {title, description} — children render inside as modal-style card
- DropdownList: {label, items:[{label, shortcut, disabled:bool, separator:bool}]}
- CommandSearch: {placeholder, groups:[{heading, items:[{label, shortcut}]}]}
- ResizablePanel: {direction:"horizontal|vertical", leftLabel, rightLabel, defaultSplit:0-100} — children in left panel
- AspectBox: {ratio:1.78|1.33|1, label, bg} — children render inside at fixed ratio
- JsonViewer: {title, data:any, maxHeight:pixels, defaultExpanded:bool} — collapsible syntax-colored JSON tree
- MarkdownBlock: {content:string, prose:bool} — renders Markdown (headings, bold, code, lists, links)
- MDCBlock: {content:string} — Markdown + component directives: ::ComponentName{prop="value"} on its own line
- AvatarCard: {title, size:"sm|md|lg"} — shows the user's stored avatar portrait (auto-fetched)
- SupportChatBlock: {agentName, height:pixels, removable:bool, bgColor:"CSS color|gradient"} — chat widget with 3D animated avatar, mic, TTS, and text input
- AgentSupportPortal: {height:pixels, bgColor:"CSS color", title} — shows all configured agents as cards (emoji+name+role), user picks one to start SupportChatBlock chat

EXAMPLE — 2 city metrics side by side:
\`\`\`spec
{"op":"add","path":"/root","value":"g"}
{"op":"add","path":"/elements/g","value":{"type":"Grid","props":{"columns":2,"gap":"md"},"children":["c1","c2"]}}
{"op":"add","path":"/elements/c1","value":{"type":"Card","props":{"title":"Tokyo","description":null},"children":["m1"]}}
{"op":"add","path":"/elements/m1","value":{"type":"Metric","props":{"label":"Temp","value":"24°C","detail":null,"trend":"up"},"children":[]}}
{"op":"add","path":"/elements/c2","value":{"type":"Card","props":{"title":"London","description":null},"children":["m2"]}}
{"op":"add","path":"/elements/m2","value":{"type":"Metric","props":{"label":"Temp","value":"12°C","detail":null,"trend":"down"},"children":[]}}
\`\`\`

## Live Notifications

To show a real-time notification overlay on the avatar screen, output a \`\`\`notify block AFTER your text.

FORMAT:
\`\`\`notify
{"type":"TYPE","title":"Title text","body":"Body text"}
\`\`\`

TYPES (27):
msg, task, approval, email, whatsapp, facebook, instagram, telegram, discord,
stripe, paypal, bank, applepay, stock, calendar, terminal, gif,
twitter, tiktok, linkedin, snapchat, youtube, reddit, twitch, otp, faceid, sms_otp

OPTIONAL FIELDS (include only when relevant):
- from: "Sender name" — for msg, email, social types
- needsApproval: true — for approval, task
- terminalCmd: "ls -la" — for terminal type
- otpCode: "847291" — for otp and sms_otp types
- phoneNumber: "+1 •••• 4782" — for sms_otp type
- biometricDevice: "iPhone 15 Pro" — for faceid type
- gifUrl: "https://..." — for gif type

EXAMPLES:
\`\`\`notify
{"type":"whatsapp","title":"New Message","body":"Are you available for a call?","from":"Sarah"}
\`\`\`

\`\`\`notify
{"type":"stripe","title":"Payment Received","body":"$149.00 from Acme Corp"}
\`\`\`

\`\`\`notify
{"type":"otp","title":"Verification Code","body":"Your code expires in 5 minutes","otpCode":"847291"}
\`\`\`

\`\`\`notify
{"type":"approval","title":"Deploy Request","body":"Deploy v2.3.1 to production?","needsApproval":true}
\`\`\``;
}

/**
 * The display set for the new chat (CHAT-SPEC-01): only components the chat
 * draws for real, all read-only (no form fields, buttons or simulated
 * notifications, which would look like they work but do nothing there).
 */
export function getChatSpecPrompt(): string {
  return `## Rich answers

When an answer has numbers to compare, a table, steps over time, or a chart, you may add ONE \`\`\`spec block AFTER your text. Keep the text complete on its own; the block only shows it better. Use only real data you have; never invent figures.

FORMAT (one JSON object per line):
\`\`\`spec
{"op":"add","path":"/root","value":"ROOT_ID"}
{"op":"add","path":"/elements/ROOT_ID","value":{"type":"COMPONENT","props":{...},"children":["CHILD_ID"]}}
\`\`\`

COMPONENTS (display only):
- Card: {title, description} — container
- Stack: {gap:"sm|md|lg", direction:"vertical|horizontal"} — container
- Grid: {columns:2|3, gap:"sm|md|lg"} — container
- Heading: {text, level:"h2|h3|h4"}
- Text: {content, muted:bool}
- Metric: {label, value, detail, trend:"up|down|neutral"}
- Badge: {text, variant:"default|success|warning|destructive"}
- Table: {data:[{...}], columns:[{key,label}]}
- Callout: {type:"info|tip|warning|important", title, content}
- Timeline: {items:[{title, description, date, status:"completed|current|upcoming"}]}
- ProgressBar: {label, value:0-100, color:"default|success|warning|destructive", showPercent:bool}
- BarChart / LineChart / AreaChart: {title, data:[{...}], xKey, yKey}
- PieChart: {title, data:[{...}], nameKey, valueKey}
- Link: {text, href} — https links only`;
}

/** The UI instruction for a turn: the full set for the classic UI, the display set for the new chat. */
export function uiSpecPrompt(set: 'full' | 'chat' = 'full'): string {
  return set === 'chat' ? getChatSpecPrompt() : getJsonRenderPrompt();
}
