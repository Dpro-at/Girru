package dev.girru.app.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneScreensTest {
    private val team = TeamMember.list(mapOf("agents" to listOf(
        mapOf("id" to "main", "name" to "Girru", "primary" to true, "department" to null),
        mapOf("id" to "sara", "name" to "Sara", "primary" to false, "department" to "marketing"),
        mapOf("id" to "karim", "name" to "Karim", "primary" to false, "role" to "specialist", "department" to "writing"),
        mapOf("id" to "lina", "name" to "Lina", "primary" to false, "department" to "support"),
        mapOf("name" to "no id"),
    )))
    private val running = TaskItem.list(mapOf("runs" to listOf(
        mapOf("id" to "chat:1", "title" to "Landing page copy", "agentId" to "karim", "agentName" to "Karim", "needsYou" to false),
        mapOf("id" to "task:2", "title" to "Clean the inbox", "agentId" to "main", "agentName" to "Girru", "needsYou" to false),
    )))
    private val approvals = ApprovalCard.list(mapOf("approvals" to listOf(
        mapOf("id" to "0b8a1c4e-0000-4000-8000-000000000001", "toolName" to "send_email", "agentId" to "sara",
            "paramsPreview" to mapOf("to" to "sales@girru.dev", "subject" to "Sales this week", "attachment" to mapOf("name" to "x"))),
    )))

    @Test
    fun teamStatusOrderAndFilters() {
        assertEquals(4, team.size)
        val board = TeamBoard.members(team, running, approvals)
        assertEquals(listOf("main", "sara", "karim", "lina"), board.map { it.id })
        assertEquals("Main agent · Clean the inbox", board[0].subtitle)
        assertEquals("Marketing · waiting for your OK", board[1].subtitle)
        assertEquals("Support", board[3].subtitle)
        assertEquals(listOf("All", "Needs you", "Marketing", "Writing", "Support"), TeamBoard.chips(board))
        assertEquals(listOf("karim"), TeamBoard.filter(board, "Writing", "").map { it.id })
        assertEquals(listOf("karim"), TeamBoard.filter(board, "All", "spec").map { it.id })
        assertEquals(listOf("sara"), TeamBoard.filter(board, "Needs you", "").map { it.id })
    }

    @Test
    fun approvalsInPlainWords() {
        assertEquals("Sara wants to send an email", approvals[0].title("Sara"))
        assertEquals(listOf("Attachment", "Subject", "To"), approvals[0].lines.map { it.first })
        assertEquals("…", approvals[0].lines[0].second)
        assertEquals("publish a page", PhoneText.action("web.publish_page"))
        assertEquals("delete files", PhoneText.action("delete_files"))
        assertEquals("Sales ops", PhoneText.title("sales_ops"))
    }

    @Test
    fun schedulesSoonestFirstPausedLast() {
        val s = ScheduleItem.list(mapOf("schedules" to listOf(
            mapOf("id" to "job:1", "title" to "Weekly", "when" to "Every Monday", "enabled" to true, "nextRun" to "2026-11-09T09:00:00Z"),
            mapOf("id" to "job:2", "title" to "Paused", "when" to "Every day", "enabled" to false, "nextRun" to null),
            mapOf("id" to "job:3", "title" to "Daily backup", "when" to "Every day at 2:00", "enabled" to true, "nextRun" to "2026-11-04T02:00:00Z"),
        )))
        assertEquals(listOf("job:3", "job:1", "job:2"), s.map { it.id })
    }
}
