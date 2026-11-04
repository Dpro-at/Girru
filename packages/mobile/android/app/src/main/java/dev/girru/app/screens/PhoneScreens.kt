package dev.girru.app.screens

import dev.girru.app.link.PhoneCommands

// What the app's own screens show (phone boards Tasks, Approvals, Team, Empty),
// read from tasks.list, schedules.list, approval.pending and team.list. Same
// rules as the iPhone's PhoneScreens.swift. Pure Kotlin for JVM tests.

data class TeamMember(
    val id: String,
    val name: String,
    val primary: Boolean,
    val role: String?,
    val department: String?,
    val description: String?,
    val status: Status = Status.FREE,
    val doing: String? = null,
) {
    enum class Status { WORKING, NEEDS_YOU, FREE }

    /** "Main agent · sorting the inbox", "Marketing · waiting for your OK", "Support". */
    val subtitle: String
        get() {
            val place = if (primary) "Main agent" else (department ?: role)?.let(PhoneText::title) ?: ""
            val now = if (status == Status.NEEDS_YOU) "waiting for your OK" else doing
            return listOfNotNull(place.takeIf { it.isNotEmpty() }, now?.takeIf { it.isNotEmpty() }).joinToString(" · ")
        }

    companion object {
        fun list(data: Any?): List<TeamMember> {
            val agents = (data as? Map<*, *>)?.get("agents") as? List<*> ?: throw IllegalArgumentException("bad_format")
            return agents.mapNotNull { a ->
                val m = a as? Map<*, *> ?: return@mapNotNull null
                val id = m["id"] as? String ?: return@mapNotNull null
                val name = m["name"] as? String ?: return@mapNotNull null
                TeamMember(id, name, m["primary"] == true, m["role"] as? String, m["department"] as? String, m["description"] as? String)
            }
        }
    }
}

data class TaskItem(
    val id: String,
    val title: String,
    val agentId: String?,
    val agentName: String?,
    val needsYou: Boolean,
    val reason: String?,
    val approvalId: String?,
) {
    val subtitle: String
        get() {
            val who = agentName ?: "Girru"
            return when {
                needsYou -> "$who needs your OK"
                !reason.isNullOrEmpty() -> "$who · $reason"
                else -> who
            }
        }

    companion object {
        fun list(data: Any?): List<TaskItem> {
            val runs = (data as? Map<*, *>)?.get("runs") as? List<*> ?: throw IllegalArgumentException("bad_format")
            return runs.mapNotNull { r ->
                val m = r as? Map<*, *> ?: return@mapNotNull null
                val id = m["id"] as? String ?: return@mapNotNull null
                val title = m["title"] as? String ?: return@mapNotNull null
                val link = m["link"] as? Map<*, *>
                TaskItem(id, title, m["agentId"] as? String, m["agentName"] as? String, m["needsYou"] == true,
                    (m["reason"] as? Map<*, *>)?.get("title") as? String, link?.get("approvalId") as? String)
            }
        }
    }
}

data class ScheduleItem(val id: String, val title: String, val whenText: String, val enabled: Boolean, val nextRun: String?) {
    companion object {
        /** Soonest first; paused ones last. `nextRun` is ISO 8601, so text order is time order. */
        fun list(data: Any?): List<ScheduleItem> {
            val items = (data as? Map<*, *>)?.get("schedules") as? List<*> ?: throw IllegalArgumentException("bad_format")
            return items.mapNotNull { s ->
                val m = s as? Map<*, *> ?: return@mapNotNull null
                val id = m["id"] as? String ?: return@mapNotNull null
                val title = m["title"] as? String ?: return@mapNotNull null
                ScheduleItem(id, title, m["when"] as? String ?: "", m["enabled"] != false, m["nextRun"] as? String)
            }.sortedWith(compareBy<ScheduleItem> { !it.enabled }.thenBy { it.nextRun ?: "￿" })
        }
    }
}

data class ApprovalCard(
    val id: String,
    val toolName: String,
    val agentId: String?,
    val needsFullView: Boolean,
    val lines: List<Pair<String, String>>,
) {
    fun title(agentName: String?) = "${agentName ?: "An agent"} wants to ${PhoneText.action(toolName)}"

    companion object {
        fun list(data: Any?): List<ApprovalCard> {
            val items = (data as? Map<*, *>)?.get("approvals") as? List<*> ?: throw IllegalArgumentException("bad_format")
            return items.mapNotNull { a ->
                val m = a as? Map<*, *> ?: return@mapNotNull null
                val id = (m["id"] as? String)?.takeIf { PhoneCommands.APPROVAL_ID.matches(it) } ?: return@mapNotNull null
                val tool = m["toolName"] as? String ?: return@mapNotNull null
                ApprovalCard(id, tool, m["agentId"] as? String, m["truncated"] == true || m["fullViewRequired"] == true, PhoneText.lines(m["paramsPreview"]))
            }
        }
    }
}

object TeamBoard {
    const val ALL = "All"
    const val NEEDS_YOU = "Needs you"

    fun members(team: List<TeamMember>, running: List<TaskItem>, approvals: List<ApprovalCard>): List<TeamMember> {
        val waiting = approvals.mapNotNull { it.agentId }.toSet()
        val doing = LinkedHashMap<String, String>()
        running.forEach { t -> t.agentId?.let { doing.putIfAbsent(it, t.title) } }
        return team.map { m ->
            when {
                m.id in waiting -> m.copy(status = TeamMember.Status.NEEDS_YOU)
                doing[m.id] != null -> m.copy(status = TeamMember.Status.WORKING, doing = doing[m.id])
                else -> m
            }
        }.sortedWith(compareBy<TeamMember> { !it.primary }.thenBy { it.status.ordinal.let { o -> if (o == 0) 1 else if (o == 1) 0 else 2 } }.thenBy { it.name.lowercase() })
    }

    fun chips(members: List<TeamMember>): List<String> {
        val out = mutableListOf(ALL)
        if (members.any { it.status == TeamMember.Status.NEEDS_YOU }) out.add(NEEDS_YOU)
        members.mapNotNull { it.department?.let(PhoneText::title)?.takeIf(String::isNotEmpty) }.distinct().forEach(out::add)
        return out
    }

    fun filter(members: List<TeamMember>, chip: String, query: String): List<TeamMember> {
        val q = query.trim().lowercase()
        return members.filter { m ->
            val inChip = chip == ALL || (if (chip == NEEDS_YOU) m.status == TeamMember.Status.NEEDS_YOU else m.department?.let(PhoneText::title) == chip)
            inChip && (q.isEmpty() || listOf(m.name, m.role ?: "", m.department ?: "", m.description ?: "").joinToString(" ").lowercase().contains(q))
        }
    }
}

object PhoneText {
    fun title(s: String): String {
        val words = s.replace('_', ' ').replace('-', ' ').trim()
        return if (words.isEmpty()) "" else words.substring(0, 1).uppercase() + words.substring(1)
    }

    fun action(tool: String): String {
        val last = tool.split('.', ':', '/').last()
        val words = last.replace('-', '_').split('_').filter { it.isNotEmpty() }.map { it.lowercase() }
        val verb = words.firstOrNull() ?: return "use a tool"
        if (words.size == 1) return "use $verb"
        val rest = words.drop(1).joinToString(" ")
        val article = if (rest.endsWith("s")) "" else if (rest.first() in "aeiou") "an " else "a "
        return "$verb $article$rest"
    }

    fun lines(preview: Any?): List<Pair<String, String>> {
        val p = preview as? Map<*, *> ?: return (preview as? String)?.takeIf { it.isNotEmpty() }?.let { listOf("" to it) } ?: emptyList()
        return p.keys.map { it.toString() }.sorted().take(8).map { k ->
            val text = when (val v = p[k]) {
                is String -> v
                is Boolean -> if (v) "yes" else "no"
                is Long, is Double -> v.toString()
                null -> "—"
                else -> "…"
            }
            title(k) to text.take(600)
        }
    }
}
