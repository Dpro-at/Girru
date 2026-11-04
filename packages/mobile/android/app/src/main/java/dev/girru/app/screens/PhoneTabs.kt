package dev.girru.app.screens

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.girru.app.R
import dev.girru.app.link.CommandReply
import dev.girru.app.link.PhoneCommands
import dev.girru.app.link.RelaySessionClient

/**
 * The four places after pairing (phone boards): Chat is the computer's own
 * chat page ([chat], the web view); Tasks, Approvals and Team are drawn here
 * from signed commands. Approve and Deny open the confirm screen, which walks
 * the full-view and unlock steps. The terminal button opens the computer's
 * terminal after the fingerprint / screen-lock check (the owner's decision).
 */
class PhoneTabs(
    context: Context,
    private val chat: View,
    private val client: RelaySessionClient,
    private val decide: (approvalId: String, approve: Boolean) -> Unit,
    /** The terminal button: the activity asks for the fingerprint, then opens the page's terminal. */
    private val openTerminal: () -> Unit,
) : LinearLayout(context) {
    enum class Place(val label: String, val icon: Int) {
        CHAT("Chat", R.drawable.ic_place_chat), TASKS("Tasks", R.drawable.ic_place_tasks),
        APPROVALS("Approvals", R.drawable.ic_place_approvals), TEAM("Team", R.drawable.ic_place_team),
    }

    private val main = Handler(Looper.getMainLooper())
    private val p = Palette(context)
    private val content = FrameLayout(context)
    private val screens = HashMap<Place, ScrollView>()
    private val bar = LinearLayout(context)
    private val badge = TextView(context)
    private var place = Place.CHAT
    private var show = "Now"
    private var chip = TeamBoard.ALL
    private var query = ""

    private var running = emptyList<TaskItem>()
    private var waiting = emptyList<TaskItem>()
    private var finished = emptyList<TaskItem>()
    private var schedules = emptyList<ScheduleItem>()
    private var approvals = emptyList<ApprovalCard>()
    private var team = emptyList<TeamMember>()
    private var problem: String? = null
    private var attached = false
    private val tick = object : Runnable {
        override fun run() {
            if (!attached) return
            refresh()
            main.postDelayed(this, if (place == Place.CHAT) 20_000 else 10_000)
        }
    }

    init {
        orientation = VERTICAL
        setBackgroundColor(p.background)
        content.addView(chat, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        for (pl in listOf(Place.TASKS, Place.APPROVALS, Place.TEAM)) {
            val s = ScrollView(context).apply { isVisible(false); isFillViewport = true }
            screens[pl] = s
            content.addView(s, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        addView(content, LayoutParams(MATCH_PARENT, 0, 1f))
        buildBar()
        addView(bar, LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        select(Place.CHAT)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached = true
        main.post(tick)
    }

    override fun onDetachedFromWindow() {
        attached = false
        main.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }

    fun select(target: Place) {
        place = target
        chat.isVisible(target == Place.CHAT)
        screens.forEach { (k, v) -> v.isVisible(k == target) }
        for (i in 0 until bar.childCount) {
            val stack = (bar.getChildAt(i) as ViewGroup).getChildAt(0) as ViewGroup
            val on = Place.entries[i] == target
            (stack.getChildAt(0) as ImageView).imageTintList = ColorStateList.valueOf(if (on) p.accent else p.secondary)
            (stack.getChildAt(1) as TextView).apply { setTextColor(if (on) p.accent else p.secondary); setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL) }
        }
        render()
        refresh()
    }

    // ---------- data ----------

    private fun refresh() {
        load(PhoneCommands.approvalList(), ApprovalCard::list) { approvals = it }
        when (place) {
            Place.TASKS -> when (show) {
                "Now" -> {
                    load(PhoneCommands.tasksList("running"), TaskItem::list) { running = it }
                    load(PhoneCommands.tasksList("waiting"), TaskItem::list) { waiting = it }
                    load(PhoneCommands.schedulesList(), ScheduleItem::list) { schedules = it }
                }
                "Scheduled" -> load(PhoneCommands.schedulesList(), ScheduleItem::list) { schedules = it }
                else -> load(PhoneCommands.tasksList("finished"), TaskItem::list) { finished = it }
            }
            Place.APPROVALS -> load(PhoneCommands.teamList(), TeamMember::list) { team = it }
            Place.TEAM -> {
                load(PhoneCommands.teamList(), TeamMember::list) { team = it }
                load(PhoneCommands.tasksList("running"), TaskItem::list) { running = it }
            }
            Place.CHAT -> Unit
        }
    }

    private fun <T> load(body: String, parse: (Any?) -> T, apply: (T) -> Unit) {
        client.call(client.signer(body), { reply ->
            main.post {
                when (reply) {
                    is CommandReply.Ok -> try { apply(parse(reply.data)); problem = null } catch (e: IllegalArgumentException) { problem = CANNOT_REACH }
                    is CommandReply.Failed -> problem = "Something went wrong on your computer. Try again."
                    CommandReply.NotDelivered -> problem = CANNOT_REACH
                }
                render()
            }
        })
    }

    private fun name(agentId: String?) = team.firstOrNull { it.id == agentId }?.name

    // ---------- drawing ----------

    private fun render() {
        badge.text = approvals.size.toString()
        badge.isVisible(approvals.isNotEmpty())
        when (place) {
            Place.TASKS -> screens[Place.TASKS]!!.fill(tasks())
            Place.APPROVALS -> screens[Place.APPROVALS]!!.fill(approvalsScreen())
            Place.TEAM -> screens[Place.TEAM]!!.fill(teamScreen())
            Place.CHAT -> Unit
        }
    }

    private fun tasks(): View = column {
        addView(titleRow("Tasks", action = iconButton("New task") { select(Place.CHAT) }, extra = terminalButton()))
        addView(segments(listOf("Now", "Scheduled", "Done"), show) { show = it; render(); refresh() })
        problemLine(this)
        when (show) {
            "Now" -> {
                if (waiting.isEmpty() && running.isEmpty() && schedules.isEmpty()) addView(empty("Nothing is running now", "Ask an agent in Chat and its work shows here.", null))
                if (waiting.isNotEmpty()) {
                    addView(label("Waiting for you", p.waiting))
                    waiting.forEach { t -> addView(card(p.waitingCard, p.waitingBorder) { addView(row(t.agentId ?: "girru", t.title, t.subtitle, chevron = true)) }.also { it.setOnClickListener { select(Place.APPROVALS) } }) }
                }
                if (running.isNotEmpty()) {
                    addView(label("Running", p.secondary))
                    addView(list(running.map { row(it.agentId ?: "girru", it.title, it.subtitle) }))
                }
                schedules.firstOrNull { it.enabled }?.let {
                    addView(label("Next scheduled", p.secondary))
                    addView(list(listOf(row(null, it.title, it.whenText))))
                }
            }
            "Scheduled" -> if (schedules.isEmpty()) addView(empty("Nothing is scheduled", "Ask an agent in Chat to do something every day or week.", null))
                else addView(list(schedules.map { row(null, it.title, if (it.enabled) it.whenText else "Paused · ${it.whenText}") }))
            else -> if (finished.isEmpty()) addView(empty("No finished tasks yet", null, null)) else addView(list(finished.map { row(it.agentId ?: "girru", it.title, it.subtitle) }))
        }
    }

    private fun approvalsScreen(): View = column {
        addView(titleRow("Approvals"))
        problemLine(this)
        if (approvals.isEmpty()) {
            addView(empty("Nothing is waiting for you", "When an agent needs your OK, it shows here and your phone tells you.", "See what the team is doing" to { select(Place.TEAM) }))
        }
        approvals.forEachIndexed { i, a ->
            if (i == 0) addView(card(p.card, p.border) {
                addView(row(a.agentId ?: "agent", a.title(name(a.agentId)), null))
                if (a.lines.isNotEmpty()) addView(column(pad = 12, bg = p.quote, radius = 12) {
                    a.lines.forEach { (k, v) -> addView(text(if (k.isEmpty()) v else "$k   $v", 14f, p.text)) }
                }.also { (it.layoutParams as? ViewGroup.MarginLayoutParams)?.topMargin = dp(12) })
                if (a.needsFullView) addView(text("Approve opens the full request first.", 13f, p.secondary))
                addView(LinearLayout(context).apply {
                    setPadding(0, dp(14), 0, 0)
                    addView(button("Deny", filled = false) { decide(a.id, false) }, LayoutParams(0, dp(48), 1f).apply { marginEnd = dp(10) })
                    addView(button("Approve", filled = true) { decide(a.id, true) }, LayoutParams(0, dp(48), 1f))
                })
            }) else addView(card(p.card, p.border) { addView(row(a.agentId ?: "agent", a.title(name(a.agentId)), "Tap Approve or Deny after the first one", chevron = false)) })
        }
    }

    // The search field and its screen stay; only the chips and the list are drawn again, so typing keeps the keyboard.
    private val search: EditText by lazy {
        EditText(context).apply {
            hint = "Search by name or job"
            textSize = 15f
            setTextColor(p.text)
            setHintTextColor(p.secondary)
            background = rounded(p.surface, 12, p.border)
            setPadding(dp(12), 0, dp(12), 0)
            isSingleLine = true
            addTextChangedListener(object : TextWatcher {
                override fun afterTextChanged(s: Editable?) { query = s?.toString() ?: ""; drawTeam() }
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            })
        }
    }
    private val chipRow by lazy { LinearLayout(context) }
    private val teamList by lazy { LinearLayout(context).apply { orientation = VERTICAL } }
    private val teamRoot: LinearLayout by lazy {
        column {
            addView(titleRow("Team"))
            addView(search, LayoutParams(MATCH_PARENT, dp(40)).apply { bottomMargin = dp(10) })
            addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(chipRow) },
                LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(12) })
            addView(teamList)
        }
    }

    private fun teamScreen(): View {
        drawTeam()
        return teamRoot
    }

    private fun drawTeam() {
        val board = TeamBoard.members(team, running, approvals)
        chipRow.removeAllViews()
        TeamBoard.chips(board).forEach { c ->
            chipRow.addView(button(c, filled = c == chip, pill = true) { chip = c; drawTeam() }, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34)).apply { marginEnd = dp(8) })
        }
        teamList.removeAllViews()
        problemLine(teamList)
        val shown = TeamBoard.filter(board, chip, query)
        if (shown.isEmpty()) teamList.addView(empty(if (query.isEmpty()) "No agents here" else "No one matches", null, null))
        else teamList.addView(list(shown.map { m ->
            row(m.id, m.name, m.subtitle, status = when (m.status) {
                TeamMember.Status.WORKING -> "Working" to p.accent
                TeamMember.Status.NEEDS_YOU -> "Needs you" to p.waiting
                TeamMember.Status.FREE -> "Free" to p.secondary
            }).also { it.setOnClickListener { select(Place.CHAT) } }
        }))
    }

    // ---------- pieces ----------

    private fun buildBar() {
        bar.orientation = HORIZONTAL
        bar.setBackgroundColor(p.card)
        bar.setPadding(0, dp(6), 0, dp(10))
        Place.entries.forEach { pl ->
            val item = FrameLayout(context)
            // select() reads the icon and the label back from this stack (index 0 of the item).
            val stack = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            stack.addView(ImageView(context).apply { setImageResource(pl.icon) }, LayoutParams(dp(24), dp(24)))
            stack.addView(text(pl.label, 11f, p.secondary).apply { gravity = Gravity.CENTER })
            item.addView(stack, FrameLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            if (pl == Place.APPROVALS) {
                badge.apply { textSize = 11f; setTextColor(Color.WHITE); setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER; background = rounded(p.waiting, 9); minWidth = dp(18); setPadding(dp(4), 0, dp(4), 0) }
                item.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(18), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { leftMargin = dp(22) })
            }
            item.contentDescription = pl.label
            item.setOnClickListener { select(pl) }
            bar.addView(item, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    private fun column(pad: Int = 16, bg: Int? = null, radius: Int = 0, body: LinearLayout.() -> Unit): LinearLayout =
        LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(pad), dp(if (bg == null) 8 else pad), dp(pad), dp(pad))
            if (bg != null) background = rounded(bg, radius)
            layoutParams = LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            body()
        }

    private fun ScrollView.fill(v: View) {
        if (childCount == 1 && getChildAt(0) === v) return
        removeAllViews()
        (v.parent as? ViewGroup)?.removeView(v)
        addView(v)
    }

    private fun titleRow(title: String, action: View? = null, extra: View? = null) = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(2), dp(12), 0, dp(10))
        addView(text(title, 30f, p.text, bold = true), LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        extra?.let { addView(it, LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(6) }) }
        action?.let { addView(it, LayoutParams(dp(44), dp(44))) }
    }

    private fun terminalButton() = ImageView(context).apply {
        setImageResource(R.drawable.ic_terminal)
        imageTintList = ColorStateList.valueOf(p.secondary)
        scaleType = ImageView.ScaleType.CENTER
        contentDescription = "Terminal"
        setOnClickListener { openTerminal() }
    }

    private fun iconButton(label: String, onClick: () -> Unit) = TextView(context).apply {
        text = "+"; textSize = 24f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
        background = rounded(p.accent, 12); contentDescription = label
        setOnClickListener { onClick() }
    }

    private fun segments(options: List<String>, selected: String, pick: (String) -> Unit) = LinearLayout(context).apply {
        background = rounded(p.segment, 10)
        setPadding(dp(3), dp(3), dp(3), dp(3))
        options.forEach { o ->
            addView(TextView(context).apply {
                text = o; textSize = 14f; gravity = Gravity.CENTER
                setTextColor(p.text); setTypeface(null, if (o == selected) Typeface.BOLD else Typeface.NORMAL)
                if (o == selected) background = rounded(p.surface, 8)
                setOnClickListener { pick(o) }
            }, LayoutParams(0, dp(34), 1f))
        }
        layoutParams = LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14) }
    }

    private fun label(t: String, color: Int) = text(t, 12f, color, bold = true).apply { setPadding(dp(4), dp(10), 0, dp(6)) }

    private fun card(bg: Int, border: Int, body: LinearLayout.() -> Unit) = LinearLayout(context).apply {
        orientation = VERTICAL
        background = rounded(bg, 16, border)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        layoutParams = LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) }
        body()
    }

    private fun list(rows: List<View>) = LinearLayout(context).apply {
        orientation = VERTICAL
        background = rounded(p.card, 14, p.border)
        rows.forEachIndexed { i, r ->
            r.setPadding(dp(14), dp(12), dp(14), dp(12))
            addView(r)
            if (i < rows.size - 1) addView(View(context).apply { setBackgroundColor(p.divider) }, LayoutParams(MATCH_PARENT, dp(1)))
        }
        layoutParams = LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10) }
    }

    private fun row(agentId: String?, title: String, subtitle: String?, chevron: Boolean = false, status: Pair<String, Int>? = null) = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(avatar(agentId), LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(12) })
        addView(LinearLayout(context).apply {
            orientation = VERTICAL
            addView(text(title, 15f, p.text, bold = true).apply { maxLines = 2 })
            subtitle?.let { addView(text(it, 13f, p.secondary).apply { maxLines = 1 }) }
        }, LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        status?.let { (t, c) -> addView(text(t, 12f, c, bold = true)) }
        if (chevron) addView(text("›", 18f, p.secondary))
    }

    private fun avatar(agentId: String?): View = if (agentId == null) {
        TextView(context).apply { text = "▦"; gravity = Gravity.CENTER; setTextColor(p.accent); background = rounded(p.quote, 10) }
    } else {
        ImageView(context).apply {
            setImageResource(R.drawable.ic_agent)
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(p.avatar(agentId)) }
            clipToOutline = true
            contentDescription = null
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
    }

    private fun empty(title: String, detail: String?, action: Pair<String, () -> Unit>?) = LinearLayout(context).apply {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(24), dp(80), dp(24), 0)
        addView(TextView(context).apply { text = "✓"; textSize = 28f; gravity = Gravity.CENTER; setTextColor(p.done); background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(p.doneSoft) } }, LayoutParams(dp(64), dp(64)).apply { bottomMargin = dp(14) })
        addView(text(title, 17f, p.text, bold = true).apply { gravity = Gravity.CENTER })
        detail?.let { addView(text(it, 15f, p.secondary).apply { gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0) }) }
        action?.let { (t, run) -> addView(text(t, 15f, p.accent).apply { setPadding(0, dp(12), 0, 0); setOnClickListener { run() } }) }
    }

    private fun button(t: String, filled: Boolean, pill: Boolean = false, onClick: () -> Unit) = Button(context).apply {
        text = t; isAllCaps = false; textSize = if (pill) 14f else 16f
        setTypeface(null, Typeface.BOLD)
        setTextColor(if (filled) Color.WHITE else p.text)
        background = rounded(if (filled) p.accent else p.surface, if (pill) 17 else 12, if (filled) null else p.border)
        stateListAnimator = null
        minHeight = 0; minimumHeight = 0
        setPadding(dp(14), 0, dp(14), 0)
        setOnClickListener { onClick() }
    }

    private fun problemLine(parent: LinearLayout) {
        problem?.let { parent.addView(text(it, 13f, p.secondary).apply { setPadding(dp(4), 0, 0, dp(8)) }) }
    }

    private fun text(t: String, size: Float, color: Int, bold: Boolean = false) = TextView(context).apply {
        text = t; textSize = size; setTextColor(color); if (bold) setTypeface(null, Typeface.BOLD)
    }

    private fun rounded(color: Int, radiusDp: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radiusDp).toFloat(); stroke?.let { setStroke(dp(1), it) }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun View.isVisible(on: Boolean) { visibility = if (on) View.VISIBLE else View.GONE }

    /** Colours from the phone boards, light and dark (ApprovalsDark). */
    private class Palette(context: Context) {
        private val dark = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        private fun c(light: Int, dark: Int) = if (this.dark) dark else light
        val accent = c(0xFF0053FD.toInt(), 0xFF4A84FE.toInt())
        val text = c(0xFF252528.toInt(), 0xFFD9E0E6.toInt())
        val secondary = c(0xFF525255.toInt(), 0xFFAEB4B9.toInt())
        val background = c(0xFFF8F9FE.toInt(), 0xFF0D1015.toInt())
        val surface = c(0xFFFFFFFF.toInt(), 0xFF141A24.toInt())
        val card = c(0xFFFDFDFD.toInt(), 0xFF0E0F12.toInt())
        val border = c(0xFFD5DFF4.toInt(), 0xFF1D2636.toInt())
        val divider = c(0xFFE8EDF8.toInt(), 0xFF1D2636.toInt())
        val quote = c(0xFFF3F7FF.toInt(), 0xFF141A24.toInt())
        val segment = c(0xFFE1E7F7.toInt(), 0xFF141A24.toInt())
        val waiting = c(0xFFA15C00.toInt(), 0xFFE0A040.toInt())
        val waitingCard = c(0xFFFFFAF3.toInt(), 0xFF1E1709.toInt())
        val waitingBorder = c(0xFFE8C9A0.toInt(), 0xFF5A4214.toInt())
        val done = c(0xFF0E7A43.toInt(), 0xFF4CC38A.toInt())
        val doneSoft = c(0xFFE7F0E9.toInt(), 0xFF12271B.toInt())
        private val avatars = intArrayOf(0xFF0053FD.toInt(), 0xFFC2410C.toInt(), 0xFF0D757F.toInt(), 0xFF7C3AED.toInt(), 0xFFB4235A.toInt(), 0xFF15803D.toInt())
        fun avatar(id: String) = avatars[(id.fold(7) { h, ch -> h * 31 + ch.code } and 0x7FFFFFFF) % avatars.size]
    }

    private companion object {
        const val MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT
        const val CANNOT_REACH = "Cannot reach your computer. Is Girru open there?"
    }
}
