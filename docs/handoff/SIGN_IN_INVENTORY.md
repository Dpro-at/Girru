# Sign-in, device connections and long chats

## First task for Codex

Follow the words a person sees when opening Girru. Start with the seven observed
account and setup views below. For each remaining flow, record the button that
opened it, the visible heading, what identity or device it affects and where Back
and Retry go. Capture the two screens the owner remembers if the states below
differ from theirs. Review the inventory with the owner before changing the flow.

## What was counted

On 14 November 2026 we opened Chrome and the installed Windows Girru Electron
1.4.4 against the same disposable Docker workspace. We recorded rendered English
text and visible control labels. We counted a distinct interactive view once
across both clients. Two views can have the same heading when they offer
different actions. These views share the application URL.

| Observed account or setup view | How to recognise or reach it |
| --- | --- |
| 1. Welcome to Girru, first owner | A fresh workspace opened with a valid private setup link offers **Create account** and **Sign in**. Both start a Google flow when available. |
| 2. Who is Girru for? | Opening the fresh workspace directly showed **For myself**, **For a company** and **Continue** in both clients. |
| 3. What does your company do? | Choosing **For a company**, entering a name and continuing opens the company-type picker, with **Skip** available. |
| 4. Open setup on this computer | Continuing without the setup code showed **Private setup link or code** and **Back**. Pasting the valid code opened the owner form. This updates the pre-Docker handoff's “only a Back button” observation. |
| 5. Create your account | The first owner form asks for name, email and password. It also offers **Create account with Google**. |
| 6. Welcome to Girru, returning user | After owner creation, a signed-out browser and a fresh Electron profile both showed one **Sign in** button. It opens the account form. |
| 7. Girru · Account | The shared returning-user form offers email/password and **Sign in with Google**. The **Sign in** button here submits the entered credentials. |

This gives **two views for ordinary sign-in, five for first-owner setup** across
the paths exercised. A person sees only the applicable branches. The two
different welcomes use the same title, and the returning user's route uses
**Sign in** for both navigation and submission. We observed one returning-user
credential form across Electron and Chrome. The external Google consent page,
conditional two-step verification, recovery and save-recovery-codes views are
outside the seven. Exercise those separately for a complete conditional count.

## English words

Matched against the rendered text and control labels of the inspected screens,
ignoring case and checking space, hyphen and joined spellings:

| Searched | Seen |
| --- | --- |
| Sign in / sign-in / signin | **Sign in**, **Sign-in**, **Google sign-in**, **Two-step sign-in** |
| Signed in / sign out | **Signed in**, **Sign out**, **Sign out everywhere** |
| Sign up / sign-up / signup / register / registration | The visible registration actions said **Create account**, **Create your account** and **Create account with Google**. |
| Log in / log-in / login / sing in / sing-in / singin | No match in the inspected UI. **Show the log** opens a diagnostic log. |
| Connection and verification terms | **Connect a phone**, **Pair a phone**, **Link Google account**, **Connect GenVR**, **memory bridge**, **Verify**, **Verification**, **Offline** |

## What the other buttons do

| Where | What the person sees and what it affects |
| --- | --- |
| Settings → Account | Local identity, two-step sign-in, signed-in devices and **Link Google account**. The page says linking Google leaves computer pairing and task permissions separate. |
| Settings → Accounts (plural) | Connected services. The observed card offered **Connect GenVR** and a code to approve in GenVR. |
| Sidebar → Connect a phone and Settings → Phone → Pair a phone | Two entrances to phone pairing. The sidebar opened a scannable code for the Girru phone app. Settings listed authorised phones and offered pairing. |
| Computers and Settings → Computers | The Computers destination showed online/offline computers and Dpro account connection status. Settings described how this computer accepts tasks from others. The Account page could simultaneously say the local owner was signed in and the computer had yet to join their Dpro account. |
| Memory → Project files / Handoffs | Project files describes what coding apps can share for a project. Handoffs says coding-app notes are written through the **memory bridge**. Neither observed page asked for a workspace password. |
| First run → Your AI tools / signed-in Chat | **Sign in** can also refer to Claude Code or Codex. This is for the agent's model provider, after the workspace owner is already signed in. |
| Electron → Connect to another Girru… | Chooses the running Girru instance the window opens. Authentication happens in the selected workspace. |

The workspace inspection used a disposable signed-in owner. To inspect Settings
without installing a model, the test browser supplied a completed onboarding
status for that one request. Pairing, Google authorisation, additional computers
and coding-app registration were not completed. Native iOS/Android screens have
their own lock and pairing flows and were not counted as desktop sign-in pages.

## Why losing contact can look different

| Condition tested | Chrome | Installed Electron |
| --- | --- | --- |
| The app loaded, but its setup-status request failed | The welcome screen said **Girru’s engine is not answering yet**. Pressing **Sign in** opened **Girru · Account**, which said **Setup status unavailable** and offered **Check setup again**. | Same two screens, wording and actions. |
| No service was listening at the address when opening the app | Chrome reported **ERR_CONNECTION_REFUSED** before Girru could render. | A native **Girru could not be reached** page offered **Try again**, **Show the log**, **Connect to another Girru…** and **Use Girru on this computer**. |

The first test failed only the setup-status request in the two test clients.
The second opened an unused local port. The owner's running service and account
were left alone. A live chat stream dropping after login is a separate remaining
check, along with two-step/recovery and a real paired phone/second computer.

## What happens when a chat fills up

Girru's saved chat path budgets recent turns in full and sends summaries of
older turns as context. The original messages remain in the chat. Its notice
reports how many older messages were summed up and offers **Read the summary**.
Reply details report turns kept, summarised and dropped, plus prompt size and
model budget. We found no cumulative “saved N tokens” figure in that view.
The owner's example of 918.5k saved tokens came from a different session.

The focused 200-turn regression passed in Linux Docker with a simulated model.
It retrieved a detail from turn 3 through the summaries within the prompt
budget. On Windows the same assertion passed, then the test file's temporary
directory cleanup failed with EPERM. No live 200-turn model session was run.
See the [history builder](../../packages/backend/src/memory/context/summaries.ts),
[chat notice](../../packages/core-ui/src/ChatMoments.tsx),
[context details](../../packages/core-ui/src/ChatRecall.tsx) and
[regression](../../packages/backend/test/memory-recall-cache.test.mjs).

## After this review

Return to the [weekend ranking task](WEEKEND_2026-11-14.md#the-measurement-bug-that-blocks-it--fix-this-first).
Make the `--known-item` sample and the 500-file cap deterministic, then measure
Girru and Flowxtra against the recorded baselines. The experimental ranking
commit remains on its branch pending comparable evidence.
