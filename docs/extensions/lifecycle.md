# Extension lifecycle

The extension runner imports the manifest's entry as an ES module and resolves its default export (or module object). It invokes `register(api)` when configured as enabled and `onDisable(api)` during supported disable handling.

`onEnable` is declared in the runner interface; do not assume a declaration proves every lifecycle path invokes it. Trace the manager/runner call site before depending on a hook. The SDK collects route registrations for scoped mounting.

Do not use an `activate()` example from an old guide as the current runner contract. Avoid unbounded timers at module import. Bound background jobs, stop owned resources during disable, and define what happens to pending work and stored data. Test repeated start/stop and failure cleanup without duplicating jobs or external effects.
