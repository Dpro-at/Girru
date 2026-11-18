# Extension UI

The current workspace lives in `packages/core-ui/`. Old instructions that copy pages into Next.js `src/app/(dashboard)/...` describe a legacy surface, not a universal installation mechanism for desktop apps.

Reuse supported workspace panes, shared chat/controllers and the existing rendering contract. Inspect the target app's host integration before selecting JSON-rendered UI, a dedicated pane or native content. A manifest cannot create a missing native host capability.

Document navigation, loading/error/disabled states, permissions, keyboard access, RTL and cleanup. Do not import backend implementation into the UI. Test browser/native transport parity and packaged assets when changing their contract.
