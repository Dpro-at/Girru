/** Display data only; host permissions never come from a component. */
export const COMPONENT_PROPS = {
  "Card": {
    "title": "string",
    "description": "string"
  },
  "Stack": {
    "gap": "string",
    "direction": "string"
  },
  "Grid": {
    "columns": "number",
    "gap": "string"
  },
  "Separator": {},
  "Heading": {
    "text": "string",
    "level": "string"
  },
  "Text": {
    "content": "string",
    "muted": "boolean",
    "size": "string"
  },
  "Link": {
    "text": "string",
    "href": "string"
  },
  "Metric": {
    "label": "string",
    "value": "scalar",
    "detail": "string",
    "trend": "string"
  },
  "Badge": {
    "text": "string",
    "variant": "string"
  },
  "Table": {
    "data": "array",
    "columns": "array",
    "emptyMessage": "string"
  },
  "Callout": {
    "type": "string",
    "title": "string",
    "content": "string"
  },
  "Timeline": {
    "items": "array"
  },
  "Accordion": {
    "items": "array"
  },
  "BarChart": {
    "title": "string",
    "data": "array",
    "xKey": "string",
    "yKey": "string",
    "color": "string",
    "height": "number"
  },
  "LineChart": {
    "title": "string",
    "data": "array",
    "xKey": "string",
    "yKey": "string",
    "color": "string",
    "height": "number"
  },
  "PieChart": {
    "title": "string",
    "data": "array",
    "nameKey": "string",
    "valueKey": "string",
    "height": "number"
  },
  "StockCandlestickChart": {
    "symbol": "string",
    "data": "array",
    "timeframe": "string",
    "showVolume": "boolean",
    "height": "number"
  },
  "OptionsChainTable": {
    "symbol": "string",
    "expirationDate": "string",
    "chains": "array",
    "currentPrice": "number",
    "highlightATM": "boolean",
    "height": "number"
  },
  "PortfolioPerformanceChart": {
    "data": "array",
    "showBenchmark": "boolean",
    "benchmarkName": "string",
    "showDrawdown": "boolean",
    "height": "number"
  },
  "AssetAllocationPie": {
    "holdings": "array",
    "showPercentages": "boolean",
    "interactive": "boolean",
    "height": "number"
  },
  "Tabs": {
    "defaultValue": "string",
    "tabs": "array"
  },
  "TabContent": {
    "value": "string"
  },
  "Button": {
    "label": "string",
    "variant": "string",
    "size": "string"
  },
  "ProgressBar": {
    "label": "string",
    "value": "number",
    "max": "number",
    "color": "string",
    "showPercent": "boolean"
  },
  "Alert": {
    "title": "string",
    "description": "string",
    "variant": "string"
  },
  "UserCard": {
    "name": "string",
    "role": "string",
    "email": "string",
    "src": "string",
    "size": "string"
  },
  "SwitchRow": {
    "label": "string",
    "description": "string",
    "checked": "boolean"
  },
  "AreaChart": {
    "title": "string",
    "data": "array",
    "xKey": "string",
    "yKey": "string",
    "color": "string",
    "height": "number",
    "gradient": "boolean"
  },
  "InputField": {
    "label": "string",
    "placeholder": "string",
    "value": "string",
    "type": "string",
    "description": "string"
  },
  "SelectField": {
    "label": "string",
    "options": "array",
    "value": "string",
    "placeholder": "string",
    "description": "string"
  },
  "TextArea": {
    "label": "string",
    "placeholder": "string",
    "value": "string",
    "rows": "number",
    "description": "string"
  },
  "CheckboxList": {
    "items": "array"
  },
  "RadioGroup": {
    "label": "string",
    "options": "array",
    "value": "string",
    "description": "string"
  },
  "SliderRow": {
    "label": "string",
    "value": "number",
    "min": "number",
    "max": "number",
    "step": "number",
    "showValue": "boolean"
  },
  "SkeletonBlock": {
    "lines": "number",
    "type": "string"
  },
  "CalendarView": {
    "title": "string",
    "selectedDates": "array"
  },
  "ToggleButton": {
    "label": "string",
    "pressed": "boolean",
    "variant": "string",
    "size": "string"
  },
  "ToggleGroup": {
    "label": "string",
    "options": "array",
    "value": "string",
    "variant": "string"
  },
  "CollapsibleSection": {
    "title": "string",
    "defaultOpen": "boolean"
  },
  "ScrollBox": {
    "maxHeight": "number"
  },
  "TooltipText": {
    "text": "string",
    "tooltip": "string",
    "muted": "boolean"
  },
  "Breadcrumb": {
    "items": "array"
  },
  "PaginationBar": {
    "currentPage": "number",
    "totalPages": "number",
    "showLabel": "boolean"
  },
  "Carousel": {
    "items": "array",
    "autoPlay": "boolean"
  },
  "HoverCard": {
    "triggerText": "string",
    "title": "string",
    "description": "string"
  },
  "OTPDisplay": {
    "code": "string",
    "length": "number",
    "label": "string",
    "placeholder": "string"
  },
  "SidePanel": {
    "title": "string",
    "description": "string",
    "side": "string"
  },
  "DrawerCard": {
    "title": "string",
    "description": "string"
  },
  "AlertDialogCard": {
    "title": "string",
    "description": "string",
    "confirmLabel": "string",
    "cancelLabel": "string",
    "variant": "string"
  },
  "DialogCard": {
    "title": "string",
    "description": "string"
  },
  "DropdownList": {
    "label": "string",
    "items": "array"
  },
  "CommandSearch": {
    "placeholder": "string",
    "groups": "array"
  },
  "ResizablePanel": {
    "direction": "string",
    "leftLabel": "string",
    "rightLabel": "string",
    "defaultSplit": "number"
  },
  "AspectBox": {
    "ratio": "number",
    "label": "string",
    "bg": "string"
  },
  "JsonViewer": {
    "title": "string",
    "data": "json",
    "maxHeight": "number",
    "defaultExpanded": "boolean"
  },
  "MarkdownBlock": {
    "content": "string",
    "prose": "boolean"
  },
  "MDCBlock": {
    "content": "string"
  },
  "AvatarCard": {
    "title": "string",
    "size": "string",
    "removable": "boolean"
  },
  "SupportChatBlock": {
    "agentName": "string",
    "height": "number",
    "removable": "boolean",
    "bgColor": "string"
  },
  "AgentSupportPortal": {
    "height": "number",
    "bgColor": "string",
    "title": "string"
  },
  "WeatherCard": {
    "location": "string",
    "condition": "string",
    "temperature": "number",
    "unit": "string",
    "humidity": "number",
    "wind": "number",
    "feelsLike": "number",
    "size": "string",
    "forecast": "array"
  }
} as const;
export type ComponentType = keyof typeof COMPONENT_PROPS;
export const COMPONENT_TYPES = Object.freeze(Object.keys(COMPONENT_PROPS) as ComponentType[]);
